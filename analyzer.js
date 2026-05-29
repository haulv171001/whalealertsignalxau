/**
 * analyzer.js — Module lõi phân tích Gamma / Max-Pain (dùng chung).
 * ----------------------------------------------------------------------------
 * UMD: chạy được cả Node (require / import) lẫn trình duyệt (window.TradeAnalyzer).
 *
 *   // Node
 *   const TA = require('./analyzer.js');
 *   const result = TA.analyze(text);          // -> object có cấu trúc
 *   console.log(TA.formatResult(result));     // -> chuỗi text như output mẫu
 *
 *   // Trình duyệt
 *   <script src="analyzer.js"></script>
 *   const result = TradeAnalyzer.analyze(text, customConfig);
 *
 * analyze(text, config?) trả về:
 *   {
 *     price, atm, blocks,
 *     buy:  [{ priority, lo, hi }, ...],
 *     sell: [{ priority, lo, hi }, ...],
 *     bias: { text, ratio, bull, bear }
 *   }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TradeAnalyzer = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // -------------------------------------------------------------------------
  // CONFIG mặc định — có thể override qua tham số thứ 2 của analyze()
  // -------------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    // --- Trọng số theo kỳ đáo hạn (expiry weighting) ---
    //   Weekly nặng nhất; càng xa ngày càng nhẹ.
    wWeekly: 1.2,
    w0to3:   1.0,
    w4to7:   0.8,
    w8plus:  0.5,

    // --- Gộp cụm & dựng vùng ---
    clusterGap: 12,   // 2 mức cách nhau <= bấy nhiêu thì gộp thành 1 cụm
    zoneMinGap: 8,    // mức phải cách giá tối thiểu mới tính vào vùng
    zonePad:    6,    // nửa độ rộng tối thiểu của 1 vùng quanh tâm cụm
    maxZones:   3,    // số vùng mỗi chiều (HIGH/MID/LOW)

    // --- Flow (dòng tiền 🐂/🐻) ---
    flowFalloff: 60,  // flow/structure càng xa giá càng loãng (điểm giá)
    flowDiv:     8,   // chuẩn hoá net-flow ($M × trọng số) về thang điểm

    // --- Gamma positioning ---
    gFloor:   0.8,    // giá còn TRÊN whale-support => sàn bullish
    gBreak:   1.2,    // giá MẤT support => bearish mạnh
    gAboveMP: 0.4,    // giá trên/dưới Max-Pain kỳ gần => cộng/trừ

    // --- Regime ---
    // ranh giới điểm tổng -> 5 regime (TRENDING BEAR … TRENDING BULL)
    regimeBands: [-2, -0.6, 0.6, 2],
  };

  // -------------------------------------------------------------------------
  // PARSING
  // -------------------------------------------------------------------------

  /** "4,531.1" -> 4531.1 ; "$15.5M" -> 15500000 ; "$818K" -> 818000 */
  function num(raw) {
    if (raw == null) return null;
    let s = String(raw).replace(/,/g, '').replace('$', '').trim();
    let mult = 1;
    if (/M$/i.test(s)) { mult = 1e6; s = s.replace(/M$/i, ''); }
    else if (/K$/i.test(s)) { mult = 1e3; s = s.replace(/K$/i, ''); }
    const v = parseFloat(s);
    return Number.isFinite(v) ? v * mult : null;
  }

  /** Lấy DTE từ nhãn: "(3DTE)" -> 3, "(Weekly)" -> 7, "(Monthly)" -> 30 */
  function parseDTE(label) {
    if (!label) return 7;
    const m = label.match(/(\d+)\s*DTE/i);
    if (m) return parseInt(m[1], 10);
    if (/weekly/i.test(label)) return 7;
    if (/monthly/i.test(label)) return 30;
    return 7;
  }

  function field(seg, key) {
    const m = seg.match(new RegExp(key + ':\\s*([\\d,\\.]+)'));
    return m ? num(m[1]) : null;
  }

  function parse(text) {
    const head = String(text).match(/ATM:\s*([\d,\.]+)\s*\|\s*CFD:\s*([\d,\.]+)/);
    const atm = head ? num(head[1]) : null;
    const cfd = head ? num(head[2]) : null;

    const segs = String(text).split('📌').slice(1);
    const blocks = [];
    for (const seg of segs) {
      const h = seg.match(/^\s*([A-Z0-9]+)\s*\(([^)]+)\)/);
      if (!h) continue;
      const b = {
        symbol: h[1], label: h[2], dte: parseDTE(h[2]),
        mp: field(seg, 'MP'), poc: field(seg, 'POC'),
        cbe: field(seg, 'CBE'), pbe: field(seg, 'PBE'),
        sup: field(seg, 'Sup'), res: field(seg, 'Res'),
      };
      const bull = seg.match(/🐂\s*\$?([\d,\.]+[MK]?)/);
      const bear = seg.match(/🐻\s*\$?([\d,\.]+[MK]?)/);
      b.bull = bull ? num(bull[1]) : 0;
      b.bear = bear ? num(bear[1]) : 0;
      if (b.mp != null) blocks.push(b);
    }
    return { atm, cfd, blocks };
  }

  // -------------------------------------------------------------------------
  // ANALYSIS
  // -------------------------------------------------------------------------

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  /** Trọng số "sức nặng" của 1 block theo kỳ đáo hạn. */
  function wOf(b, CFG) {
    if (/weekly/i.test(b.label)) return CFG.wWeekly;
    if (b.dte <= 3) return CFG.w0to3;
    if (b.dte <= 7) return CFG.w4to7;
    return CFG.w8plus;
  }

  /** Max-Pain "fair value" = trung bình MP có trọng số kỳ đáo hạn. */
  function fairValue(blocks, CFG) {
    let s = 0, w = 0;
    for (const b of blocks) if (b.mp != null) { const x = wOf(b, CFG); s += b.mp * x; w += x; }
    return w ? s / w : null;
  }

  /** MP của kỳ gần nhất (DTE nhỏ nhất). */
  function dominantMP(blocks) {
    const m = blocks.filter((b) => b.mp != null).sort((a, b) => a.dte - b.dte);
    return m.length ? m[0].mp : null;
  }

  /** Whale-support gần nhất nằm DƯỚI giá. */
  function nearestSupport(blocks, price) {
    const sups = blocks.map((b) => b.sup).filter((v) => v != null && v < price);
    return sups.length ? Math.max.apply(null, sups) : null;
  }

  /** Gom các mức (kèm trọng số) ở 1 phía so với giá. */
  function gatherLevels(blocks, keys, price, side, CFG) {
    const out = [];
    for (const b of blocks) {
      const w = wOf(b, CFG);
      for (const k of keys) {
        const v = b[k];
        if (v == null) continue;
        if (side === 'above' && v > price + CFG.zoneMinGap) out.push({ v, w });
        if (side === 'below' && v < price - CFG.zoneMinGap) out.push({ v, w });
      }
    }
    return out;
  }

  /** Gộp các mức gần nhau thành cụm; mỗi cụm có tâm (weighted), biên, và "stack". */
  function clusterWeighted(levels, gap) {
    if (!levels.length) return [];
    levels.sort((a, b) => a.v - b.v);
    const groups = [];
    let cur = [levels[0]];
    for (let i = 1; i < levels.length; i++) {
      if (levels[i].v - cur[cur.length - 1].v <= gap) cur.push(levels[i]);
      else { groups.push(cur); cur = [levels[i]]; }
    }
    groups.push(cur);
    return groups.map((c) => {
      const W = c.reduce((s, x) => s + x.w, 0);
      const center = c.reduce((s, x) => s + x.v * x.w, 0) / W;
      return {
        center,
        lo: Math.min.apply(null, c.map((x) => x.v)),
        hi: Math.max.apply(null, c.map((x) => x.v)),
        stack: W * c.length,   // sức nặng cụm = trọng số × số mức chồng
        count: c.length,
      };
    });
  }

  /** Cụm -> vùng [lo,hi], đảm bảo bề rộng tối thiểu. */
  function bandOf(c, CFG) {
    if (c.hi - c.lo >= 2 * CFG.zonePad) return { lo: c.lo, hi: c.hi };
    return { lo: c.center - CFG.zonePad, hi: c.center + CFG.zonePad };
  }

  const TIERS = ['HIGH', 'MID', 'LOW'];

  /**
   * Chọn `maxZones` cụm GẦN GIÁ NHẤT, gán ưu tiên theo `rankKey` (lớn = HIGH),
   * rồi sắp xếp hiển thị gần-giá-trước.
   *   - BUY : rankKey = -distance  => gần nhất = HIGH (phòng thủ đầu tiên).
   *   - SELL: rankKey =  stack     => chồng dày nhất = HIGH (kháng cự mạnh nhất).
   */
  function pickZones(clusters, price, CFG, rankKey) {
    const near = clusters.slice()
      .sort((a, b) => Math.abs(a.center - price) - Math.abs(b.center - price))
      .slice(0, CFG.maxZones);
    near.slice().sort((a, b) => rankKey(b) - rankKey(a)).forEach((c, i) => { c.priority = TIERS[i] || 'LOW'; });
    return near
      .sort((a, b) => Math.abs(a.center - price) - Math.abs(b.center - price))
      .map((c) => Object.assign({ priority: c.priority }, bandOf(c, CFG)));
  }

  /** BUY = cụm support (Sup/MP/PBE) dưới giá; HIGH = gần giá nhất. */
  function buyZones(blocks, price, CFG) {
    const clusters = clusterWeighted(gatherLevels(blocks, ['sup', 'mp', 'pbe'], price, 'below', CFG), CFG.clusterGap);
    return clusters.length ? pickZones(clusters, price, CFG, (c) => -Math.abs(c.center - price)) : [];
  }

  /** SELL = cụm kháng cự (Res/POC/MP) trên giá; HIGH = stack mạnh nhất. */
  function sellZones(blocks, price, CFG) {
    const clusters = clusterWeighted(gatherLevels(blocks, ['res', 'poc', 'mp'], price, 'above', CFG), CFG.clusterGap);
    return clusters.length ? pickZones(clusters, price, CFG, (c) => c.stack) : [];
  }

  /** "Stack" có chiết khấu theo khoảng cách: xa giá thì ít tác dụng tức thời. */
  function decayedStack(clusters, price, falloff) {
    return clusters.reduce((s, c) => s + c.stack / (1 + Math.abs(c.center - price) / falloff), 0);
  }

  /**
   * REGIME = điểm tổng từ:  flow (chuẩn hoá theo khoảng cách)
   *                       + gamma positioning (sàn support / MP kỳ gần)
   *                       + structure (support vs resistance, chiết khấu xa).
   * Trả về cùng object "bias" cũ (có .text) để giữ tương thích.
   */
  function bias(blocks, price, CFG) {
    const fair = fairValue(blocks, CFG);
    const nSup = nearestSupport(blocks, price);
    const domMP = dominantMP(blocks);

    // 1) FLOW — net 🐂/🐻 ($M) × trọng số kỳ × độ gần (xa giá => loãng).
    let flow = 0;
    for (const b of blocks) {
      const anchor = b.mp != null ? b.mp : price;
      const prox = 1 / (1 + Math.abs(anchor - price) / CFG.flowFalloff);
      flow += ((b.bull - b.bear) / 1e6) * wOf(b, CFG) * prox;
    }
    const flowScore = clamp(flow / CFG.flowDiv, -1.5, 1.5);

    // 2) GAMMA — còn trên support => sàn bullish; mất support => bearish mạnh.
    let gamma = 0;
    if (nSup != null) gamma += price > nSup ? CFG.gFloor : -CFG.gBreak;
    if (domMP != null) gamma += price > domMP ? CFG.gAboveMP : -CFG.gAboveMP;

    // 3) STRUCTURE — support dưới vs resistance trên, đều chiết khấu theo khoảng cách.
    const supStack = decayedStack(clusterWeighted(gatherLevels(blocks, ['sup', 'mp', 'pbe'], price, 'below', CFG), CFG.clusterGap), price, CFG.flowFalloff);
    const resStack = decayedStack(clusterWeighted(gatherLevels(blocks, ['res', 'poc', 'mp'], price, 'above', CFG), CFG.clusterGap), price, CFG.flowFalloff);
    const structScore = clamp((supStack - resStack) / (supStack + resStack || 1), -1, 1);

    const score = flowScore + gamma + structScore;

    const names = ['TRENDING BEAR', 'BALANCED BEAR', 'BALANCED', 'BALANCED BULL', 'TRENDING BULL'];
    let idx = 0;
    while (idx < CFG.regimeBands.length && score > CFG.regimeBands[idx]) idx++;

    const bull = blocks.reduce((s, b) => s + b.bull, 0);
    const bear = blocks.reduce((s, b) => s + b.bear, 0);
    return {
      text: names[idx],
      score, flowScore, gamma, structScore,
      fair, nearSup: nSup, domMP,
      bull, bear, ratio: bull / (bull + bear || 1),
    };
  }

  // -------------------------------------------------------------------------
  // API CÔNG KHAI
  // -------------------------------------------------------------------------

  /**
   * Phân tích feed -> object có cấu trúc.
   * @param {string} text   - nội dung feed
   * @param {object} [config] - override DEFAULT_CONFIG (merge nông)
   * @returns {object|{error:string}}
   */
  function analyze(text, config) {
    const CFG = Object.assign({}, DEFAULT_CONFIG, config || {});
    const { cfd, atm, blocks } = parse(text);
    const price = cfd != null ? cfd : atm;
    if (price == null || !blocks.length) {
      return { error: 'Không đọc được dữ liệu (thiếu CFD/ATM hoặc block 📌).' };
    }
    return {
      price, atm, blocks,
      buy: buyZones(blocks, price, CFG),
      sell: sellZones(blocks, price, CFG),
      bias: bias(blocks, price, CFG),
    };
  }

  const fmt = (n) => Math.round(n).toString();

  /** Định dạng kết quả analyze() thành chuỗi text như output mẫu. */
  function formatResult(r) {
    if (!r || r.error) return r ? r.error : '';
    const lines = [];
    for (const z of r.buy) lines.push(`BUY ${fmt(z.lo)}–${fmt(z.hi)} (${z.priority} PRIORITY)`);
    lines.push('');
    for (const z of r.sell) lines.push(`SELL ${fmt(z.lo)}–${fmt(z.hi)} (${z.priority} PRIORITY)`);
    lines.push('');
    lines.push(`BIAS: ${r.bias.text}`);
    return lines.join('\n');
  }

  /** Tiện ích: phân tích & trả về luôn chuỗi text. */
  function analyzeText(text, config) {
    return formatResult(analyze(text, config));
  }

  return {
    DEFAULT_CONFIG,
    num, parseDTE, parse,
    buyZones, sellZones, bias,
    analyze, formatResult, analyzeText,
  };
}));
