// Archives a paid invoice's PDF to Dropbox when a payment is recorded.
// Triggered by a Supabase database webhook on INSERT into `payments` (see README "Dropbox 归档" section).
//
// The PDF layout is a Node port of buildPdf() in index.html (canvas drawing + hand-written PDF wrapper).
// Keep the two in sync if the invoice template changes.
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const ROOT = path.join(__dirname, '..');
const DROPBOX_ROOT = process.env.DROPBOX_ROOT || '/Webbalances/Sales/Income';
const ARCHIVE_FROM = process.env.ARCHIVE_FROM || '2026-11-01';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zliptskoppkldonjhzsr.supabase.co';
// Existing folder names under Sales/Income (mixed "03.March" / "04.April" style, copied as-is)
const MONTH_FOLDERS = ['01.Jan', '02.Feb', '03.March', '04.April', '05.May', '06.June',
  '07.July', '08.August', '09.Sep', '10.Oct', '11.Nov', '12.Dec'];

// Times New Roman is not installed on the server; Tinos is its metric-compatible open-source twin.
let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  const dir = path.join(ROOT, 'fonts');
  GlobalFonts.registerFromPath(path.join(dir, 'Tinos-Regular.ttf'), 'Times New Roman');
  GlobalFonts.registerFromPath(path.join(dir, 'Tinos-Bold.ttf'), 'Times New Roman');
  GlobalFonts.registerFromPath(path.join(dir, 'Tinos-Italic.ttf'), 'Times New Roman');
  GlobalFonts.registerFromPath(path.join(dir, 'Tinos-BoldItalic.ttf'), 'Times New Roman');
  // CJK fallback for Chinese names (Times has no CJK glyphs); subset of Noto Sans SC, SIL OFL
  GlobalFonts.registerFromPath(path.join(dir, 'NotoSansSC-Regular-subset.ttf'), 'NotoCJK');
  fontsReady = true;
}

// ---------- helpers (ported from index.html) ----------
function r2(n) { return Math.round(n * 100) / 100; }
function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function parseD(s) { const p = String(s).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function dmy(d) { return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }
function safe(t) { return String(t).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim(); }
function fmt(n) { return r2(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// same mapping as docPdf() in index.html
function docToPdfModel(d, c) {
  const cust = c || { name: '[No customer linked]', addr: '', phone: '' };
  const lines = (d.lines && d.lines.length ? d.lines : [{ desc: d.title, qty: 1, price: d.total }]).map(function (l) {
    const q = num(l.qty), p = num(l.price);
    const blank = !q && !p;
    return { desc: l.desc, qty: blank ? '' : String(q), unit: blank ? '' : fmt(p), amt: blank ? '' : fmt(q * p), header: !!l.header, indent: !!l.indent };
  });
  return {
    kind: 'INVOICE', no: d.doc_no, date: dmy(parseD(d.doc_date)), valid: null,
    name: cust.name, addr: cust.addr || '', phone: cust.phone || '', lines: lines, total: fmt(d.total), terms: d.terms || '',
    bankDetail: { name: 'Webbalances solution', account: '8010 438 379', bank: 'CIMB BANK' }
  };
}

async function loadLogo() {
  try { return await loadImage(path.join(ROOT, 'logo.png')); } catch (e) { return null; }
}

async function renderInvoicePdf(doc, cust) {
  ensureFonts();
  const logo = await loadLogo();
  return buildInvoicePdf(docToPdfModel(doc, cust), logo);
}

// ---------- Supabase (service role, server-side only) ----------
function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: 'Bearer ' + key };
}
async function sbOne(table, query) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + query, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase ' + table + ' ' + r.status);
  const rows = await r.json();
  return rows[0] || null;
}

// ---------- Dropbox ----------
async function dropboxAccessToken() {
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
      client_id: process.env.DROPBOX_APP_KEY,
      client_secret: process.env.DROPBOX_APP_SECRET
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Dropbox token: ' + (j.error_description || r.status));
  return j.access_token;
}

// True if any file under the Income folder already carries this invoice number in its name.
async function alreadyArchived(token, docNo) {
  const want = new RegExp('(?<![A-Za-z0-9])' + docNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])', 'i');
  let r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: DROPBOX_ROOT, recursive: true, limit: 2000 })
  });
  let j = await r.json();
  if (!r.ok) {
    if (j.error_summary && j.error_summary.startsWith('path/not_found')) return false;
    throw new Error('Dropbox list: ' + (j.error_summary || r.status));
  }
  for (;;) {
    if ((j.entries || []).some(e => e['.tag'] === 'file' && want.test(e.name))) return true;
    if (!j.has_more) return false;
    r = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: j.cursor })
    });
    j = await r.json();
    if (!r.ok) throw new Error('Dropbox list: ' + (j.error_summary || r.status));
  }
}

async function uploadToDropbox(token, filePath, bytes) {
  // Dropbox requires non-ASCII characters in the API-Arg header to be escaped
  const arg = JSON.stringify({ path: filePath, mode: 'add', autorename: false, mute: true })
    .replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': arg, 'Content-Type': 'application/octet-stream' },
    body: bytes
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Dropbox upload: ' + (j.error_summary || r.status));
  return j;
}

// ---------- main ----------
// Archives the invoice of one payment row. Returns a result object for logging / the response.
async function archivePayment(pay) {
  const payDate = String(pay.pay_date || '').slice(0, 10);
  if (!pay.document_id) return { skipped: 'no document' };
  if (payDate < ARCHIVE_FROM) return { skipped: 'payment before ' + ARCHIVE_FROM };

  const doc = await sbOne('documents', 'id=eq.' + pay.document_id + '&select=*');
  if (!doc) return { skipped: 'document not found' };
  if (doc.kind !== 'invoice') return { skipped: 'not an invoice (quotation)' };
  if (!doc.lines) doc.lines = [];
  const cust = doc.customer_id ? await sbOne('customers', 'id=eq.' + doc.customer_id + '&select=*') : null;

  const token = await dropboxAccessToken();
  if (await alreadyArchived(token, doc.doc_no)) return { skipped: 'already archived', doc_no: doc.doc_no };

  const folder = MONTH_FOLDERS[Number(payDate.slice(5, 7)) - 1];
  const name = safe(doc.doc_no + '_' + (cust ? cust.name : '[No customer linked]')) + '.pdf';
  const dropPath = DROPBOX_ROOT + '/' + folder + '/' + name;
  const bytes = await renderInvoicePdf(doc, cust);
  await uploadToDropbox(token, dropPath, Buffer.from(bytes));
  return { archived: dropPath, bytes: bytes.length };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.headers['x-webhook-secret'] !== secret) return res.status(401).json({ error: 'unauthorized' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (body.table && body.table !== 'payments') return res.status(200).json({ skipped: 'not a payment event' });
  if (body.type && body.type !== 'INSERT') return res.status(200).json({ skipped: 'not an insert' });

  try {
    const result = await archivePayment(body.record || {});
    console.log('archive-invoice', JSON.stringify(result));
    return res.status(200).json(result);
  } catch (err) {
    console.error('archive-invoice failed', err);
    return res.status(500).json({ error: String(err && err.message || err) });
  }
};

module.exports.archivePayment = archivePayment;
module.exports.renderInvoicePdf = renderInvoicePdf;

// ---------- PDF drawing (copied from index.html buildPdf, adapted for Node canvas) ----------
async function buildInvoicePdf(doc, logo) {
    var W = 1190, H = 1684, INK = '#111111', GREY = '#374151', BLACK = '#000000';
    var TF = "'Times New Roman', NotoCJK, Times, serif";
    var draw = function () {
      var cv = createCanvas(W, H);
      var g = cv.getContext('2d');
      // Same measurements as the uploaded invoice template (A4, CSS px at 794px wide), scaled onto the canvas
      var S = W / 794, MM = 96 / 25.4 * S;
      var P = function (css) { return css * S; };
      var L = 16 * MM, R = W - L, CW = R - L;
      var y = 18 * MM;
      g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, W, H);
      var txt = function (t, x, yy, font, color, align) { g.font = font; g.fillStyle = color || INK; g.textAlign = align || 'left'; g.fillText(t, x, yy); };
      var wrap = function (t, maxW, font) {
        g.font = font; var out = [], line = '';
        String(t).split(' ').forEach(function (w) { var cand = line ? line + ' ' + w : w; if (g.measureText(cand).width > maxW && line) { out.push(line); line = w; } else line = cand; });
        if (line) out.push(line); return out;
      };
      var bar = function () { g.fillStyle = BLACK; g.fillRect(L, y, CW, P(14)); y += P(14); };
      bar();

      // header: logo + company block
      var hTop = y + P(14);
      if (logo) g.drawImage(logo, L + P(10), hTop + P(4), P(88), P(88));
      var lx = L + P(10) + P(88) + P(40), lineH = P(16);
      txt('WEBBALANCE SOLUTIONS  (CA0366370-K)', lx, hTop + P(12), '700 ' + P(11) + 'px ' + TF, '#2bb673');
      ['UNIT 6, LEVEL 4, SETIAWALK MALL  (BLOCK K),', 'PERSIARAN WAWASAN, PUSAT BANDAR PUCHONG', '47160 PUCHONG SELANGOR', 'EMAIL: bernice@webbalances.com', 'PHONE: 6010 831 2238']
        .forEach(function (l, i) { txt(l, lx, hTop + lineH * (i + 1) + P(12), '400 ' + P(11) + 'px ' + TF, INK); });
      y = hTop + P(96) + P(10);

      // billing box: bill-to on the left, date / number / terms cells on the right
      var padT = P(6), padB = P(6), padL = P(8);
      var addrLines = [];
      String(doc.addr || '').split('\n').forEach(function (p) { addrLines = addrLines.concat(wrap(p, CW * 0.5, '400 ' + P(13) + 'px ' + TF)); });
      var billRows = [doc.name].concat(addrLines);
      if (doc.phone) billRows.push(doc.phone);
      var billH = P(15) + P(8) + billRows.length * P(18.2);
      var metaItems = [['DATE', doc.date], [doc.kind + ' #', doc.no]];
      if (doc.kind === 'INVOICE') metaItems.push(['TERMS', doc.terms || '']);
      var mRow = P(21), mTop = P(4), metaH = mTop + metaItems.length * mRow;
      var boxH = Math.max(billH, metaH + P(30)) + padT + padB;
      g.fillStyle = '#f2f2f2'; g.fillRect(L, y, CW, boxH);
      var cTop = y + padT;
      txt('BILL  TO :', L + padL, cTop + 17, '700 ' + P(13) + 'px ' + TF, INK);
      billRows.forEach(function (l, i) { txt(l, L + padL, cTop + P(15) + P(8) + i * P(18.2) + 19, '400 ' + P(13) + 'px ' + TF, INK); });

      var tblW = P(133), tblL = R - tblW;
      g.font = '400 ' + P(13) + 'px ' + TF;
      var labelW = Math.max.apply(null, metaItems.map(function (m) { return g.measureText(m[0]).width; }));
      var labelsL = tblL - P(60) - labelW;
      var metaTop = y + boxH - padB - P(30) - metaH + mTop;
      var cellTop = metaTop - mTop;
      metaItems.forEach(function (m, i) {
        txt(m[0], labelsL, metaTop + i * mRow + 21, '400 ' + P(13) + 'px ' + TF, INK);
        var rowTop = cellTop + i * mRow;
        g.fillStyle = '#FFFFFF'; g.fillRect(tblL, rowTop, tblW, mRow);
        g.strokeStyle = '#999999'; g.lineWidth = 1; g.strokeRect(tblL, rowTop, tblW, mRow);
        txt(m[1], tblL + tblW / 2, rowTop + 21, (i === 0 ? '700' : '400') + ' ' + P(12.5) + 'px ' + TF, INK, 'center');
      });
      y += boxH;

      // items table: black header, striped rows, 15 rows minimum (as in the template)
      var tY = y, thH = P(19);
      var qtyW = P(72), priceW = P(115), amtW = P(132);
      var cQty = R - amtW - priceW - qtyW, cPrice = R - amtW - priceW, cAmt = R - amtW;
      // the amount header wraps inside its 132px column, as in the template
      var amtHead = ['TOTAL AMOUNT(MYR)'];
      g.font = '700 ' + P(13) + 'px ' + TF;
      if (g.measureText(amtHead[0]).width > amtW - P(6)) { amtHead = ['TOTAL AMOUNT', '(MYR)']; thH += P(15); }
      g.fillStyle = BLACK; g.fillRect(L, tY, CW, thH);
      var thY = tY + P(2) + 16;
      txt('DESCRIPTION', L + P(3), thY, '700 ' + P(13) + 'px ' + TF, '#FFFFFF');
      txt('QTY', (cQty + cPrice) / 2, thY, '700 ' + P(13) + 'px ' + TF, '#FFFFFF', 'center');
      txt('Price', (cPrice + cAmt) / 2, thY, '700 ' + P(13) + 'px ' + TF, '#FFFFFF', 'center');
      amtHead.forEach(function (t, k) { txt(t, (cAmt + R) / 2, thY + k * P(15), '700 ' + P(13) + 'px ' + TF, '#FFFFFF', 'center'); });
      // remark lines (no qty / price) are drawn at 80% size; one empty line is left under the Expired Date line
      var rows = [], seenItem = false;
      doc.lines.forEach(function (l) {
        var isNote = !l.header && !l.qty && !l.unit && !l.amt;
        if (!isNote && !l.indent && seenItem) rows.push({ l: null, dl: [], h: P(18) }); // blank row between two items
        if (!isNote && !l.indent) seenItem = true;
        var font = '400 ' + (isNote ? P(13) * 0.8 : P(13)) + 'px ' + TF;
        var dl = wrap(String(l.desc || ''), cQty - L - P(6) - (l.indent ? P(24) : 0), font);
        rows.push({ l: l, dl: dl, font: font, h: Math.max(P(18), dl.length * P(15) + P(3)) });
        if (/^Expired Date/i.test(String(l.desc || '').trim())) rows.push({ l: null, dl: [], h: P(18) });
      });
      while (rows.length < 15) rows.push({ l: null, dl: [], h: P(18) });
      var rY = tY + thH;
      rows.forEach(function (row, idx) {
        if (idx % 2) { g.fillStyle = '#f2f2f2'; g.fillRect(L, rY, CW, row.h); }
        if (row.l) {
          row.dl.forEach(function (s, k) { txt(s, L + P(3) + (row.l.indent ? P(24) : 0), rY + 18 + k * P(15), row.font); });
          txt(String(row.l.qty), (cQty + cPrice) / 2, rY + 18, '400 ' + P(13) + 'px ' + TF, INK, 'center');
          txt(String(row.l.unit), cPrice + P(8), rY + 18, '400 ' + P(13) + 'px ' + TF, INK);
          txt(String(row.l.amt), (cAmt + R) / 2, rY + 18, '400 ' + P(13) + 'px ' + TF, INK, 'center');
        }
        g.strokeStyle = BLACK; g.lineWidth = 1;
        [cQty, cPrice, cAmt].forEach(function (x) { g.beginPath(); g.moveTo(x, rY); g.lineTo(x, rY + row.h); g.stroke(); });
        rY += row.h;
      });
      g.strokeStyle = BLACK; g.lineWidth = 1; g.strokeRect(L, tY, CW, rY - tY);

      // total row: label, 108px gap, grey value cell
      y = rY + P(4);
      var totH = P(3) * 2 + P(15);
      txt('TOTAL(MYR)', R - amtW - P(108), y + P(3) + 16, '700 ' + P(13) + 'px ' + TF, INK, 'right');
      g.fillStyle = '#f2f2f2'; g.fillRect(R - amtW, y, amtW, totH);
      txt(String(doc.total), R, y + P(3) + 16, '700 ' + P(13) + 'px ' + TF, INK, 'right');
      y += totH;

      if (doc.kind === 'QUOTATION') {
        y += P(30);
        ['Terms:', '1. 50% deposit upon confirmation, balance upon completion.', '2. This quotation is valid for 30 days.']
          .forEach(function (l, i) { txt(l, L, y + i * P(18) + 18, (i ? '400' : '700') + ' ' + P(13) + 'px ' + TF, INK); });
        y += P(18) * 3;
      } else if (doc.bankDetail) {
        y += P(2);
        var titleH = P(4) + P(15), lineBox = P(2) + P(15), bw = CW * 0.58;
        var bH = titleH + 3 * lineBox;
        g.strokeStyle = '#333333'; g.lineWidth = 1; g.strokeRect(L, y, bw, bH);
        g.fillStyle = BLACK; g.fillRect(L, y, bw, titleH);
        txt('Bank Detail', L + P(3), y + P(2) + 16, '700 ' + P(13) + 'px ' + TF, '#FFFFFF');
        [doc.bankDetail.name, doc.bankDetail.account, doc.bankDetail.bank].forEach(function (t, i) {
          txt(t, L + P(3), y + titleH + i * lineBox + P(1) + 16, '700 ' + P(13) + 'px ' + TF, INK);
        });
        y += bH;
      }

      // note (margin 30px top, 22px bottom in the template), then the closing bar
      y += P(30);
      txt('This ' + (doc.kind === 'QUOTATION' ? 'quotation' : 'invoice') + ' is generated by computer. No signature needed', W / 2, y + 17, 'italic 700 ' + P(13) + 'px ' + TF, INK, 'center');
      y += P(15) + P(22);
      bar();
      return cv.encodeSync('jpeg', 92);
    };
    var jpg = draw();
    var enc = new TextEncoder(), parts = [], len = 0, offs = [];
    var push = function (x) { var b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    push('%PDF-1.4\n');
    var obj = function (n, body) { offs[n] = len; push(n + ' 0 obj\n' + body + '\nendobj\n'); };
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
    offs[4] = len;
    push('4 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + W + ' /Height ' + H + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpg.length + ' >>\nstream\n');
    push(jpg); push('\nendstream\nendobj\n');
    var cs = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
    obj(5, '<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream');
    var xref = len, x = 'xref\n0 6\n0000000000 65535 f \n';
    for (var n = 1; n <= 5; n++) x += String(offs[n]).padStart(10, '0') + ' 00000 n \n';
    push(x + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    var out = new Uint8Array(len), p = 0;
    parts.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  }

