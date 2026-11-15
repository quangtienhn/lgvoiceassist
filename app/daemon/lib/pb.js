// Minimal protobuf (proto3) encoder/decoder for the ESPHome native API subset we use.
// Schema: { fieldName: [fieldNumber, type, subSchema?, repeated?] }
// Types: string, bytes, bool, uint32, enum, fixed32, float, message
'use strict';

function writeVarint(out, v) {
  v = v >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
}

function readVarint(buf, pos) {
  var result = 0, shift = 0, b;
  do {
    if (pos >= buf.length) throw new Error('varint out of range');
    b = buf[pos++];
    if (shift < 28) result |= (b & 0x7f) << shift;
    else result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return [result >>> 0 === result ? result : result >>> 0, pos];
}

function encodeField(out, num, type, sub, value) {
  switch (type) {
    case 'bool':
      if (!value) return;
      writeVarint(out, (num << 3) | 0); out.push(1); return;
    case 'uint32': case 'enum':
      if (!value) return;
      writeVarint(out, (num << 3) | 0); writeVarint(out, value); return;
    case 'fixed32': {
      if (!value) return;
      writeVarint(out, (num << 3) | 5);
      var b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0, 0);
      for (var i = 0; i < 4; i++) out.push(b[i]);
      return;
    }
    case 'float': {
      if (!value) return;
      writeVarint(out, (num << 3) | 5);
      var f = Buffer.alloc(4); f.writeFloatLE(value, 0);
      for (var j = 0; j < 4; j++) out.push(f[j]);
      return;
    }
    case 'string': case 'bytes': case 'message': {
      var data;
      if (type === 'string') { if (!value) return; data = Buffer.from(String(value), 'utf8'); }
      else if (type === 'bytes') { if (!value || !value.length) return; data = value; }
      else data = encode(sub, value || {});
      writeVarint(out, (num << 3) | 2); writeVarint(out, data.length);
      for (var k = 0; k < data.length; k++) out.push(data[k]);
      return;
    }
    default: throw new Error('unknown type ' + type);
  }
}

function encode(schema, obj) {
  var out = [];
  Object.keys(schema).forEach(function (name) {
    var def = schema[name], v = obj[name];
    if (v === undefined || v === null) return;
    if (def[3]) v.forEach(function (item) {
      // repeated: always emit (even empty strings/zero) for message/string items
      if (def[1] === 'message' || def[1] === 'string') {
        var data = def[1] === 'message' ? encode(def[2], item) : Buffer.from(String(item), 'utf8');
        writeVarint(out, (def[0] << 3) | 2); writeVarint(out, data.length);
        for (var k = 0; k < data.length; k++) out.push(data[k]);
      } else encodeField(out, def[0], def[1], def[2], item);
    });
    else encodeField(out, def[0], def[1], def[2], v);
  });
  return Buffer.from(out);
}

function decode(schema, buf) {
  var byNum = {}, obj = {};
  Object.keys(schema).forEach(function (name) {
    byNum[schema[name][0]] = [name].concat(schema[name]);
    if (schema[name][3]) obj[name] = [];
  });
  var pos = 0, r;
  while (pos < buf.length) {
    r = readVarint(buf, pos); var key = r[0]; pos = r[1];
    var num = key >>> 3, wt = key & 7, def = byNum[num], val;
    if (wt === 0) { r = readVarint(buf, pos); val = r[0]; pos = r[1]; }
    else if (wt === 5) { val = buf.slice(pos, pos + 4); pos += 4; }
    else if (wt === 1) { val = buf.slice(pos, pos + 8); pos += 8; }
    else if (wt === 2) { r = readVarint(buf, pos); var len = r[0]; pos = r[1]; val = buf.slice(pos, pos + len); pos += len; }
    else throw new Error('unsupported wire type ' + wt);
    if (!def) continue;
    var name = def[0], type = def[2], sub = def[3];
    switch (type) {
      case 'bool': val = !!val; break;
      case 'uint32': case 'enum': break;
      case 'fixed32': val = val.readUInt32LE(0); break;
      case 'float': val = val.readFloatLE(0); break;
      case 'string': val = val.toString('utf8'); break;
      case 'bytes': break;
      case 'message': val = decode(sub, val); break;
    }
    if (def[4]) obj[name].push(val); else obj[name] = val;
  }
  return obj;
}

module.exports = { encode: encode, decode: decode, writeVarint: writeVarint, readVarint: readVarint };
