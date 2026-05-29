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
    // BUY: thang giá neo theo pivot = (CFD + MaxPain gần nhất)/2.
    // Mỗi cặp [lệch_đáy, lệch_đỉnh] tính từ pivot (số âm = dưới pivot).
    buyHigh: [-6, 4],    // vùng HIGH: ôm quanh giá hiện tại
    buyMid:  [-19, -9],  // vùng MID : lùi ~15 điểm
    buyLow:  [-38, -25], // vùng LOW : lùi ~35 điểm

    // SELL: neo theo cụm kháng cự phía trên giá.
    sellWidths: [10, 13, 15], // độ rộng vùng HIGH / MID / LOW
    sellMinGap: 10,           // kháng cự phải cách giá tối thiểu bấy nhiêu
    sellTopPad: 0,            // đẩy đỉnh vùng SELL lên trên cụm kháng cự
    clusterGap: 12,           // 2 mức cách nhau <= bấy nhiêu thì gộp thành 1 cụm

    maxZones: 3,        // số vùng mỗi chiều (HIGH/MID/LOW)
    biasSlopeThld: 5,   // ngưỡng độ dốc Max-Pain để lệch BIAS 1 nấc
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

  function nearestMP(blocks, price) {
    const withMP = blocks.filter((b) => b.mp != null).sort((a, b) => a.dte - b.dte);
    return withMP.length ? withMP[0].mp : price;
  }

  /** BUY = thang giá neo theo pivot = trung bình (giá, MaxPain gần nhất). */
  function buyZones(blocks, price, CFG) {
    const pivot = (price + nearestMP(blocks, price)) / 2;
    const tiers = [
      { priority: 'HIGH', off: CFG.buyHigh },
      { priority: 'MID',  off: CFG.buyMid },
      { priority: 'LOW',  off: CFG.buyLow },
    ].slice(0, CFG.maxZones);
    return tiers.map((t) => ({ priority: t.priority, lo: pivot + t.off[0], hi: pivot + t.off[1] }));
  }

  /** SELL = thang giá neo theo các cụm kháng cự (MP/POC/Res) nằm trên giá. */
  function sellZones(blocks, price, CFG) {
    const levels = [];
    for (const b of blocks) {
      for (const k of ['mp', 'poc', 'res']) {
        if (b[k] != null && b[k] > price + CFG.sellMinGap) levels.push(b[k]);
      }
    }
    if (!levels.length) return [];
    levels.sort((a, b) => a - b);

    const clusters = [];
    let cur = [levels[0]];
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] - cur[cur.length - 1] <= CFG.clusterGap) cur.push(levels[i]);
      else { clusters.push(cur); cur = [levels[i]]; }
    }
    clusters.push(cur);

    const tops = clusters
      .map((c) => ({ top: Math.max.apply(null, c) }))
      .sort((a, b) => a.top - b.top)
      .slice(0, CFG.maxZones);

    const tiers = ['HIGH', 'MID', 'LOW'];
    return tops.map((c, i) => {
      const width = CFG.sellWidths[i] != null ? CFG.sellWidths[i] : CFG.sellWidths[CFG.sellWidths.length - 1];
      const hi = c.top + CFG.sellTopPad;
      return { priority: tiers[i] || 'LOW', lo: hi - width, hi };
    });
  }

  /** BIAS = nền từ tỉ lệ $ Bull/Bear + lệch theo độ dốc Max-Pain term-structure. */
  function bias(blocks, CFG) {
    const bull = blocks.reduce((s, b) => s + b.bull, 0);
    const bear = blocks.reduce((s, b) => s + b.bear, 0);
    const ratio = bull / (bull + bear || 1);

    const scale = ['STRONG BEARISH', 'BEARISH', 'SLIGHT BEARISH',
                   'NEUTRAL', 'SLIGHT BULLISH', 'BULLISH', 'STRONG BULLISH'];
    let idx;
    if (ratio >= 0.65) idx = 6;
    else if (ratio >= 0.58) idx = 5;
    else if (ratio >= 0.53) idx = 4;
    else if (ratio > 0.47) idx = 3;
    else if (ratio > 0.42) idx = 2;
    else if (ratio > 0.35) idx = 1;
    else idx = 0;

    const mp = blocks.filter((b) => b.mp != null).sort((a, b) => a.dte - b.dte);
    let adj = idx;
    if (mp.length >= 2) {
      const slope = mp[mp.length - 1].mp - mp[0].mp;
      if (slope > CFG.biasSlopeThld) adj = Math.min(scale.length - 1, idx + 1);
      else if (slope < -CFG.biasSlopeThld) adj = Math.max(0, idx - 1);
    }
    return { text: adj === idx ? scale[idx] : `${scale[idx]} → ${scale[adj]}`, ratio, bull, bear };
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
      bias: bias(blocks, CFG),
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
