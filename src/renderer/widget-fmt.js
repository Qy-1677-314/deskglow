'use strict';
/* 小组件的公共层：日期 / 时间格式化（含时区、农历、节日）、电量文案、元素数据模型。
   渲染层用 <script> 引入，主进程用 require 引入，改一处两边一起变。 */
(function () {
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const WEEK_FULL = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const pad2 = (n) => (n < 10 ? '0' + n : String(n));

  /* ------------------------------ 时区 ------------------------------ */
  const TZ_LIST = [
    { id: 'auto', label: '跟随系统' },
    { id: 'UTC', label: 'UTC 协调世界时' },
    { id: 'Asia/Shanghai', label: '北京 / 上海 · UTC+8' },
    { id: 'Asia/Hong_Kong', label: '中国香港 · UTC+8' },
    { id: 'Asia/Macau', label: '中国澳门 · UTC+8' },
    { id: 'Asia/Taipei', label: '中国台北 · UTC+8' },
    { id: 'Asia/Tokyo', label: '东京 · UTC+9' },
    { id: 'Asia/Seoul', label: '首尔 · UTC+9' },
    { id: 'Asia/Singapore', label: '新加坡 · UTC+8' },
    { id: 'Asia/Bangkok', label: '曼谷 · UTC+7' },
    { id: 'Asia/Kolkata', label: '新德里 · UTC+5:30' },
    { id: 'Asia/Dubai', label: '迪拜 · UTC+4' },
    { id: 'Europe/Moscow', label: '莫斯科 · UTC+3' },
    { id: 'Europe/Berlin', label: '柏林 · UTC+1' },
    { id: 'Europe/Paris', label: '巴黎 · UTC+1' },
    { id: 'Europe/London', label: '伦敦 · UTC+0' },
    { id: 'America/Sao_Paulo', label: '圣保罗 · UTC-3' },
    { id: 'America/New_York', label: '纽约 · UTC-5' },
    { id: 'America/Chicago', label: '芝加哥 · UTC-6' },
    { id: 'America/Denver', label: '丹佛 · UTC-7' },
    { id: 'America/Los_Angeles', label: '洛杉矶 · UTC-8' },
    { id: 'Pacific/Auckland', label: '奥克兰 · UTC+13' },
  ];

  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const partFmts = new Map();

  function partsFormatter(tz) {
    const zone = tz && tz !== 'auto' ? tz : null;
    const key = zone || 'local';
    if (partFmts.has(key)) return partFmts.get(key);
    let f;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone || undefined,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        weekday: 'short',
      });
    } catch (_) {
      f = new Intl.DateTimeFormat('en-US', {
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        weekday: 'short',
      });
    }
    partFmts.set(key, f);
    return f;
  }

  /** 取指定时区下的年月日时分秒，坏时区自动退回系统时区 */
  function parts(date, tz) {
    let list;
    try {
      list = partsFormatter(tz).formatToParts(date);
    } catch (_) {
      list = partsFormatter('auto').formatToParts(date);
    }
    const o = {};
    for (const p of list) if (p.type !== 'literal') o[p.type] = p.value;
    return {
      year: Number(o.year),
      month: Number(o.month),
      day: Number(o.day),
      hour: Number(o.hour) % 24,
      minute: Number(o.minute),
      second: Number(o.second),
      weekday: WD[o.weekday] == null ? 0 : WD[o.weekday],
    };
  }

  /* ------------------------------ 农历 ------------------------------ */
  const LUNAR_INFO = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
    0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
    0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
    0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
    0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
    0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
    0x0d520,
  ];
  const LUNAR_MIN = 1900;
  const LUNAR_MAX = 2100;
  const LMON = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
  const LDAY = [
    '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
    '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
    '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
  ];

  function leapMonth(y) { return LUNAR_INFO[y - LUNAR_MIN] & 0xf; }
  function leapDays(y) { return leapMonth(y) ? ((LUNAR_INFO[y - LUNAR_MIN] & 0x10000) ? 30 : 29) : 0; }
  function monthDays(y, m) { return (LUNAR_INFO[y - LUNAR_MIN] & (0x10000 >> m)) ? 30 : 29; }

  function yearDays(y) {
    let sum = 348;
    for (let i = 0x8000; i > 0x8; i >>= 1) if (LUNAR_INFO[y - LUNAR_MIN] & i) sum += 1;
    return sum + leapDays(y);
  }

  /** 公历 → 农历。超出 1900-2100 时返回 null，界面上不显示农历行。 */
  function toLunar(y, m, d) {
    if (y < LUNAR_MIN || y > LUNAR_MAX) return null;
    let offset = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / 86400000);
    if (offset < 0) return null;
    let i;
    let temp = 0;
    for (i = LUNAR_MIN; i < LUNAR_MAX + 1 && offset > 0; i++) {
      temp = yearDays(i);
      offset -= temp;
    }
    if (offset < 0) { offset += temp; i--; }
    const year = i;
    const leap = leapMonth(year);
    let isLeap = false;
    for (i = 1; i < 13 && offset > 0; i++) {
      if (leap > 0 && i === leap + 1 && !isLeap) { --i; isLeap = true; temp = leapDays(year); }
      else temp = monthDays(year, i);
      if (isLeap && i === leap + 1) isLeap = false;
      offset -= temp;
    }
    if (offset === 0 && leap > 0 && i === leap + 1) {
      if (isLeap) isLeap = false;
      else { isLeap = true; --i; }
    }
    if (offset < 0) { offset += temp; --i; }
    return { year, month: i, day: offset + 1, isLeap };
  }

  function lunarText(l) {
    if (!l) return '';
    const m = (l.isLeap ? '闰' : '') + LMON[l.month - 1] + '月';
    // 初一按习惯只写月份，例如「农历腊月初一」写作「农历腊月」
    return l.day === 1 ? m : m + LDAY[l.day - 1];
  }

  /* ------------------------------ 节气 ------------------------------ */
  const TERM_INFO = [
    0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
    263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758,
  ];
  const TERMS = [
    '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
    '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
    '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
  ];

  function termDay(y, n) {
    const ms = 31556925974.7 * (y - 1900) + TERM_INFO[n] * 60000 + Date.UTC(1900, 0, 6, 2, 5);
    return new Date(ms).getUTCDate();
  }

  function termName(y, m, d) {
    if (y < 1900 || y > 2100) return '';
    const a = (m - 1) * 2;
    if (d <= 15) return termDay(y, a) === d ? TERMS[a] : '';
    return termDay(y, a + 1) === d ? TERMS[a + 1] : '';
  }

  /* ------------------------------ 节日 ------------------------------ */
  const FEST_SOLAR = {
    '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '4-1': '愚人节',
    '5-1': '劳动节', '5-4': '青年节', '6-1': '儿童节', '7-1': '建党节',
    '8-1': '建军节', '9-10': '教师节', '10-1': '国庆节', '12-24': '平安夜',
    '12-25': '圣诞节', '12-31': '跨年夜',
  };
  const FEST_LUNAR = {
    '1-1': '春节', '1-15': '元宵节', '2-2': '龙头节', '5-5': '端午节',
    '7-7': '七夕', '7-15': '中元节', '8-15': '中秋节', '9-9': '重阳节',
    '12-8': '腊八节', '12-23': '小年',
  };

  /** 第 n 个星期 w 是几号（w: 0=周日） */
  function nthWeekday(y, m, w, n) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((w - first + 7) % 7) + (n - 1) * 7;
  }

  function festivalOf(p, lunar) {
    const solarKey = p.month + '-' + p.day;
    const term = termName(p.year, p.month, p.day);
    if (term === '清明') return '清明';
    if (lunar) {
      if (!lunar.isLeap) {
        const key = lunar.month + '-' + lunar.day;
        if (FEST_LUNAR[key]) return FEST_LUNAR[key];
        // 除夕：腊月的最后一天
        if (lunar.month === 12 && lunar.day === monthDays(lunar.year, 12)) return '除夕';
      }
    }
    if (FEST_SOLAR[solarKey]) return FEST_SOLAR[solarKey];
    if (p.month === 5 && p.day === nthWeekday(p.year, 5, 0, 2)) return '母亲节';
    if (p.month === 6 && p.day === nthWeekday(p.year, 6, 0, 3)) return '父亲节';
    if (p.month === 11 && p.day === nthWeekday(p.year, 11, 4, 4)) return '感恩节';
    return '';
  }

  /* ------------------------------ 格式化 ------------------------------ */
  const TOKEN = /\[[^\]]*\]|YYYY|dddd|FEST|ddd|NL|JQ|MM|DD|HH|hh|mm|ss|YY|M|D|H|h|m|s|A|a/g;

  /**
   * 令牌：YYYY YY MM M DD D dddd ddd · HH H hh h mm m ss s · A a · NL 农历 · JQ 节气 · FEST 节日
   * [方括号里的内容] 原样输出，用来写死「AM」这种会和令牌撞车的字。
   */
  function format(p, pattern, opts) {
    const o = opts || {};
    const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
    const use12 = !!o.h12;
    const lunar = p.lunar === undefined ? toLunar(p.year, p.month, p.day) : p.lunar;
    const term = termName(p.year, p.month, p.day);
    const fest = festivalOf(p, lunar);
    const map = {
      YYYY: String(p.year),
      YY: pad2(p.year % 100),
      MM: pad2(p.month),
      M: String(p.month),
      DD: pad2(p.day),
      D: String(p.day),
      dddd: WEEK_FULL[p.weekday],
      ddd: WEEK[p.weekday],
      HH: pad2(use12 ? h12 : p.hour),
      H: String(use12 ? h12 : p.hour),
      hh: pad2(h12),
      h: String(h12),
      mm: pad2(p.minute),
      m: String(p.minute),
      ss: pad2(p.second),
      s: String(p.second),
      A: p.hour < 12 ? 'AM' : 'PM',
      a: p.hour < 12 ? '上午' : '下午',
      NL: lunarText(lunar),
      JQ: term,
      FEST: fest,
    };
    let pat = String(pattern == null ? '' : pattern);
    let out = pat.replace(TOKEN, (t) => {
      if (t.charAt(0) === '[') return t.slice(1, -1);
      return map[t] == null ? t : map[t];
    });
    // 12 小时制但格式里没写 AM/PM：自动补一个，否则上午下午分不清
    if (use12 && !/A|a/.test(pat.replace(/\[[^\]]*\]/g, ''))) {
      out += p.hour < 12 ? ' AM' : ' PM';
    }
    return out;
  }

  function formatDate(date, pattern, opts) {
    const o = opts || {};
    const p = parts(date instanceof Date ? date : new Date(), o.tz);
    p.lunar = toLunar(p.year, p.month, p.day);
    return format(p, pattern, o);
  }

  /** 电量文案：{p} 百分比 {s} 状态 {t} 剩余时间 */
  function batteryText(pattern, b) {
    const info = b || {};
    const pct = info.percent == null ? null : Math.round(info.percent);
    let state = '使用电池';
    if (!info.hasBattery) state = '无电池';
    else if (info.charging) state = '充电中';
    else if (info.ac) state = '已接通电源';

    let left = '';
    if (info.charging) left = '充电中';
    else if (info.minutes > 0) {
      const hh = Math.floor(info.minutes / 60);
      const mm = info.minutes % 60;
      left = hh ? hh + ' 小时 ' + mm + ' 分' : mm + ' 分';
    }

    return String(pattern == null ? '{p}%' : pattern)
      .replace(/\{p\}/g, pct == null ? '--' : String(pct))
      .replace(/\{s\}/g, state)
      .replace(/\{t\}/g, left || '—');
  }

  /* ------------------------------ 元素模型 ------------------------------ */
  const BASE_TEXT = {
    size: 16, weight: 500, italic: false, underline: false,
    color: '#ffffff', letter: 0, line: 1.25, font: '',
    shadow: { on: true, blur: 10, y: 2, color: '#000000', alpha: 45 },
  };
  const BASE_BG = { on: false, color: '#ffffff', alpha: 22 };
  const BASE_SHADOW = { on: false, blur: 18, y: 6, color: '#000000', alpha: 28 };

  const ELEMENT_DEFS = {
    clock: {
      label: '时钟', short: '时',
      desc: '显示时间，可换时区与 12/24 小时制',
      pad: 0,
      text: { size: 42, weight: 600 },
      data: { pattern: 'HH:mm', tz: 'auto', h12: false },
    },
    date: {
      label: '日期', short: '日',
      desc: '显示日期，可以带上农历、节气与节日',
      pad: 0,
      text: { size: 15, weight: 500 },
      data: { pattern: 'YYYY年M月D日 ddd', lunar: false, lunarSize: 12, holiday: false, holidaySize: 12 },
    },
    battery: {
      label: '电量', short: '电',
      desc: '电池图标、电量条、百分比，三部分随意开关',
      pad: 6,
      text: { size: 13, weight: 500 },
      data: {
        pattern: '{p}%',
        icon: true, bar: true, text: true, inline: true,
        iconSize: 26, barW: 54, barH: 5,
        low: 20, lowColor: '#f0506e',
        iconColor: '', barColor: '', textColor: '',
      },
    },
    text: {
      label: '文本', short: '文',
      desc: '想写什么写什么，可以换行',
      pad: 0,
      text: { size: 16, weight: 500 },
      data: { content: '在这里输入文字' },
    },
    image: {
      label: '图片', short: '图',
      desc: '放进一张图片，可以设圆角与大小',
      pad: 0,
      box: { w: 180, h: 180 },
      text: { size: 16 },
      data: { src: '', fit: 'contain' },
    },
  };
  const ELEMENT_TYPES = ['clock', 'date', 'battery', 'text', 'image'];

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const clampNum = (v, min, max, fb) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.max(min, Math.min(max, n));
  };
  function deep(base, extra) {
    const out = isObj(base) ? { ...base } : {};
    if (!isObj(extra)) return out;
    for (const k of Object.keys(extra)) {
      if (isObj(out[k]) && isObj(extra[k])) out[k] = deep(out[k], extra[k]);
      else if (extra[k] !== undefined) out[k] = extra[k];
    }
    return out;
  }

  /** 补齐缺省字段，读旧配置 / 导入别人给的预设都走这里 */
  function normalizeElement(raw) {
    const r = isObj(raw) ? raw : {};
    const type = ELEMENT_DEFS[r.type] ? r.type : 'text';
    const def = ELEMENT_DEFS[type];
    const el = {
      id: typeof r.id === 'string' ? r.id : '',
      type,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 24) : def.label,
      x: Math.round(clampNum(r.x, -6000, 12000, 96)),
      y: Math.round(clampNum(r.y, -6000, 12000, 96)),
      w: Math.round(clampNum(r.w, 0, 4000, def.box ? def.box.w : 0)),
      h: Math.round(clampNum(r.h, 0, 4000, def.box ? def.box.h : 0)),
      rotate: Math.round(clampNum(r.rotate, -180, 180, 0)),
      opacity: clampNum(r.opacity, 0, 100, 100),
      visible: r.visible !== false,
      align: ['left', 'center', 'right'].includes(r.align) ? r.align : 'left',
      pad: Math.round(clampNum(r.pad, 0, 80, def.pad == null ? 0 : def.pad)),
      radius: Math.round(clampNum(r.radius, 0, 160, 12)),
      bg: deep(BASE_BG, r.bg),
      shadow: deep(BASE_SHADOW, r.shadow),
      text: deep(deep(BASE_TEXT, def.text), r.text),
      data: deep(def.data, r.data),
    };
    el.bg.alpha = clampNum(el.bg.alpha, 0, 100, 22);
    el.shadow.alpha = clampNum(el.shadow.alpha, 0, 100, 28);
    el.text.size = clampNum(el.text.size, 5, 240, 16);
    el.text.weight = clampNum(el.text.weight, 100, 900, 500);
    el.text.letter = clampNum(el.text.letter, -10, 40, 0);
    el.text.line = clampNum(el.text.line, 0.8, 3, 1.25);
    el.text.shadow.alpha = clampNum(el.text.shadow.alpha, 0, 100, 45);
    // 文字类元素撑不出高度时保持自动，图片则必须有框
    if (type === 'image') {
      if (!el.w) el.w = 180;
      if (!el.h) el.h = 180;
    }
    return el;
  }

  function createElement(type, opts) {
    const o = opts || {};
    const def = ELEMENT_DEFS[type] || ELEMENT_DEFS.text;
    const el = normalizeElement({ type, x: o.x, y: o.y, w: o.w, h: o.h });
    el.id = o.id || '';
    el.name = o.name || def.label;
    return el;
  }

  /** 列表里那句灰色小字 */
  function summary(el) {
    if (!el) return '';
    if (el.type === 'clock') {
      const tz = TZ_LIST.find((t) => t.id === el.data.tz);
      return el.data.pattern + ' · ' + (tz && tz.id !== 'auto' ? tz.label.split(' · ')[0] : '本地时间') + (el.data.h12 ? ' · 12 小时' : '');
    }
    if (el.type === 'date') {
      const tags = [];
      if (el.data.lunar) tags.push('农历');
      if (el.data.holiday) tags.push('节日');
      return el.data.pattern + (tags.length ? ' · ' + tags.join(' / ') : '');
    }
    if (el.type === 'battery') {
      const parts = [];
      if (el.data.icon) parts.push('电池');
      if (el.data.bar) parts.push('电量条');
      if (el.data.text) parts.push('百分比');
      return parts.length ? parts.join(' + ') + (el.data.inline ? ' · 叠加' : ' · 分开') : '三部分都关了';
    }
    if (el.type === 'text') {
      const s = String(el.data.content || '').replace(/\s+/g, ' ').trim();
      return s ? s.slice(0, 18) + (s.length > 18 ? '…' : '') : '空白文本';
    }
    if (el.type === 'image') return el.data.src ? '已选择图片' : '还没有图片';
    return '';
  }

  const api = {
    WEEK, WEEK_FULL, TZ_LIST, ELEMENT_DEFS, ELEMENT_TYPES,
    parts, format, formatDate, toLunar, lunarText, termName, festivalOf,
    batteryText, normalizeElement, createElement, summary, clampNum, deep,
    TIME_PRESETS: ['HH:mm', 'HH:mm:ss', 'h:mm A', 'a h:mm', 'H:mm'],
    DATE_PRESETS: ['YYYY年M月D日 ddd', 'YYYY-MM-DD', 'M月D日 ddd', 'MM/DD ddd', 'YYYY年M月D日 dddd'],
    BATTERY_PRESETS: ['{p}%', '{p}% · {s}', '{s} {p}%', '{p}% 约 {t}'],
    LUNAR_PRESETS: ['NL', 'NL JQ', 'NL · JQ · FEST'],
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DGFmt = api;
})();
