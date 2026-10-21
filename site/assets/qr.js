/*
 * Tiny offline QR code generator for the RallyFlow website and flyer (no network, no dependencies).
 * Byte mode, error correction level M, versions 1-10 (up to 213 bytes: plenty for a URL).
 * Algorithm follows ISO/IEC 18004 (structure after Project Nayuki's public-domain reference design).
 *
 *   RallyQR.toSvg('https://example.com', { margin: 4, dark: '#000', light: '#fff' }) -> '<svg ...>'
 *   RallyQR.matrix('text') -> boolean[][] (true = dark module)
 */
(function (global) {
  'use strict';

  var ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  var FORMAT_ECC_M = 0; // level M is encoded as 0b00

  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMul(coef, factor); });
    });
    return result;
  }

  function rawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(ver) {
    return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  function alignmentPositions(ver, size) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function utf8(text) {
    var bytes = [];
    var encoded = unescape(encodeURIComponent(text));
    for (var i = 0; i < encoded.length; i++) bytes.push(encoded.charCodeAt(i));
    return bytes;
  }

  function encodeData(bytes, ver) {
    var bits = [];
    function put(value, len) { for (var i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); }
    put(4, 4); // byte mode
    put(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    var capacity = dataCodewords(ver) * 8;
    put(0, Math.min(4, capacity - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    var out = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      out.push(byte);
    }
    for (var pad = 0xec; out.length < dataCodewords(ver); pad ^= 0xec ^ 0x11) out.push(pad);
    return out;
  }

  function addEcc(data, ver) {
    var numBlocks = NUM_BLOCKS[ver];
    var eccLen = ECC_PER_BLOCK[ver];
    var raw = Math.floor(rawDataModules(ver) / 8);
    var numShort = numBlocks - (raw % numBlocks);
    var shortLen = Math.floor(raw / numBlocks);
    var divisor = rsDivisor(eccLen);
    var blocks = [];
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        if (i !== shortLen - eccLen || j >= numShort) result.push(blocks[j][i]);
      }
    }
    return result;
  }

  function build(ver, codewords, mask) {
    var size = ver * 4 + 17;
    var modules = [];
    var fn = [];
    for (var y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      fn.push(new Array(size).fill(false));
    }
    function set(x, y, dark) { modules[y][x] = dark; fn[y][x] = true; }

    for (var i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy));
        var x = cx + dx, yy = cy + dy;
        if (x >= 0 && x < size && yy >= 0 && yy < size) set(x, yy, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var align = alignmentPositions(ver, size);
    for (i = 0; i < align.length; i++) for (var j = 0; j < align.length; j++) {
      var last = align.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    function formatBits(m) {
      var data = (FORMAT_ECC_M << 3) | m;
      var rem = data;
      for (var n = 0; n < 10; n++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      function bit(k) { return ((bits >>> k) & 1) !== 0; }
      for (var a = 0; a <= 5; a++) set(8, a, bit(a));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (a = 9; a < 15; a++) set(14 - a, 8, bit(a));
      for (a = 0; a < 8; a++) set(size - 1 - a, 8, bit(a));
      for (a = 8; a < 15; a++) set(8, size - 15 + a, bit(a));
      set(8, size - 8, true);
    }
    formatBits(mask);
    if (ver >= 7) {
      var rem = ver;
      for (var n = 0; n < 12; n++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      var vbits = (ver << 12) | rem;
      for (i = 0; i < 18; i++) {
        var b = ((vbits >>> i) & 1) !== 0;
        var a2 = size - 11 + (i % 3), b2 = Math.floor(i / 3);
        set(a2, b2, b); set(b2, a2, b);
      }
    }

    var bitIndex = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (var k = 0; k < 2; k++) {
        var x = right - k;
        var upward = ((right + 1) & 2) === 0;
        var yy = upward ? size - 1 - vert : vert;
        if (!fn[yy][x] && bitIndex < codewords.length * 8) {
          modules[yy][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }

    for (y = 0; y < size; y++) for (x = 0; x < size; x++) {
      if (fn[y][x]) continue;
      var invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      }
      if (invert) modules[y][x] = !modules[y][x];
    }
    return modules;
  }

  /** Penalty rules 1 (runs), 2 (2x2 blocks) and 4 (balance) of the standard, used to pick a mask. */
  function penalty(m) {
    var size = m.length, score = 0, dark = 0;
    for (var y = 0; y < size; y++) {
      for (var dir = 0; dir < 2; dir++) {
        var run = 1;
        for (var x = 1; x < size; x++) {
          var cur = dir === 0 ? m[y][x] : m[x][y];
          var prev = dir === 0 ? m[y][x - 1] : m[x - 1][y];
          if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
        }
      }
      for (x = 0; x < size; x++) {
        if (m[y][x]) dark++;
        if (y < size - 1 && x < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
      }
    }
    var total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  function matrix(text) {
    var bytes = utf8(String(text));
    var ver = 1;
    while (ver <= 10 && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
    if (ver > 10) throw new Error('Text too long for this QR generator');
    var codewords = addEcc(encodeData(bytes, ver), ver);
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var m = build(ver, codewords, mask);
      var s = penalty(m);
      if (s < bestScore) { best = m; bestScore = s; }
    }
    return best;
  }

  function toSvg(text, opts) {
    opts = opts || {};
    var margin = opts.margin == null ? 4 : opts.margin;
    var m = matrix(text);
    var size = m.length + margin * 2;
    var path = '';
    for (var y = 0; y < m.length; y++) for (var x = 0; x < m.length; x++) {
      if (m[y][x]) path += 'M' + (x + margin) + ' ' + (y + margin) + 'h1v1h-1z';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="100%" height="100%" fill="' + (opts.light || '#ffffff') + '"/>' +
      '<path d="' + path + '" fill="' + (opts.dark || '#000000') + '"/></svg>';
  }

  global.RallyQR = { matrix: matrix, toSvg: toSvg };
})(typeof window !== 'undefined' ? window : globalThis);
