'use strict';

// Config-aware reader/editor for Civilization VI .Civ6Cfg files.
//
// Civ6 .Civ6Cfg files use the same typed-marker binary format as the header of
// a .Civ6Save, but WITHOUT the trailing compressed game-state blob, and without
// the GAME_SPEED anchor / single END_UNCOMPRESSED delimiter that pydt's
// save-oriented top-level parse() relies on. So we cannot use pydt's parse()/
// addMod()/deleteMod() directly on configs.
//
// The low-level byte readers below are adapted from pydt/civ6-save-parser (MIT,
// Mike Rosack) -- the per-field encoding is identical; only the top-level
// navigation differs. We locate the MOD_BLOCK_* arrays by scanning for their
// markers, then read/splice them as 0x0B arrays.
//
// Editing model: pure buffer splicing. We only ever rewrite the bytes of a mod
// block; every other byte of the file is preserved verbatim, so round-trip
// identity is guaranteed by construction for anything we don't touch.

const iconv = require('iconv-lite');
const diacritics = require('diacritics');

const MOD_BLOCK_MARKERS = {
  MOD_BLOCK_1: Buffer.from([0x5c, 0xae, 0x27, 0x84]),
  MOD_BLOCK_2: Buffer.from([0xc8, 0xd1, 0x8c, 0x1b]),
  MOD_BLOCK_3: Buffer.from([0x44, 0x7f, 0xd4, 0xfe]),
  MOD_BLOCK_4: Buffer.from([0xbb, 0x5e, 0x30, 0x88]),
};

const MOD_ID = Buffer.from([0x54, 0x5f, 0xc4, 0x04]);
const MOD_TITLE = Buffer.from([0x72, 0xe1, 0x34, 0x30]);

const GAME_DATA = { MOD_ID, MOD_TITLE };

const ZLIB_HEADER = Buffer.from([0x78, 0x9c]);
const COMPRESSED_DATA_END = Buffer.from([0, 0, 0xff, 0xff]);

const DATA_TYPES = { BOOLEAN: 1, INTEGER: 2, STRING: 5, UTF_STRING: 6, ARRAY_START: 0x0a };

// ---------------------------------------------------------------------------
// Low-level readers (adapted from pydt/civ6-save-parser, MIT).
// ---------------------------------------------------------------------------

function readState(buffer, state) {
  if (!state) {
    state = { pos: 0, next4: buffer.slice(0, 4) };
  } else {
    if (state.pos >= buffer.length - 4) return null;
    state.next4 = buffer.slice(state.pos, state.pos + 4);
  }
  return state;
}

function readString(buffer, state) {
  let result = null;
  const strLenBuf = Buffer.concat([buffer.slice(state.pos, state.pos + 3), Buffer.from([0])]);
  const strLen = strLenBuf.readUInt32LE(0);
  state.pos += 2;

  const strInfo = buffer.slice(state.pos, state.pos + 6);
  if (strInfo[1] === 0 || strInfo[1] === 0x20) {
    state.pos += 10;
    result = "Don't know what this kind of string is...";
  } else if (strInfo[1] === 0x21) {
    state.pos += 6;
    const nullTerm = buffer.indexOf(0, state.pos) - state.pos;
    result = buffer.slice(state.pos, state.pos + nullTerm).toString();
    state.pos += strLen;
  }
  return result === null ? '' : result;
}

function readUtfString(buffer, state) {
  let result = null;
  const strLen = buffer.readUInt16LE(state.pos) * 2;
  state.pos += 2;
  if (buffer.slice(state.pos, state.pos + 6).equals(Buffer.from([0, 0x21, 2, 0, 0, 0]))) {
    state.pos += 6;
    result = buffer.slice(state.pos, state.pos + strLen - 2).toString('ucs2');
    state.pos += strLen;
  }
  return result === null ? '' : result;
}

function readBoolean(buffer, state) {
  state.pos += 8;
  const result = !!buffer[state.pos];
  state.pos += 4;
  return result;
}

function readInt(buffer, state) {
  state.pos += 8;
  const result = buffer.readUInt32LE(state.pos);
  state.pos += 4;
  return result;
}

function readArray0A(buffer, state) {
  const result = [];
  state.pos += 8;
  const arrayLen = buffer.readUInt32LE(state.pos);
  state.pos += 4;
  for (let i = 0; i < arrayLen; i++) {
    const index = buffer.readUInt32LE(state.pos);
    if (index > arrayLen) return arrayLen;
    state = readState(buffer, state);
    const info = parseEntry(buffer, state, true);
    result.push(info.data);
  }
  return result;
}

function parseEntry(buffer, state, dontSkip) {
  let successfulParse;
  let result;
  do {
    const typeBuffer = buffer.slice(state.pos + 4, state.pos + 8);
    result = { marker: state.next4, type: typeBuffer.readUInt32LE() };
    state.pos += 8;
    successfulParse = true;

    if (!dontSkip && (result.marker.readUInt32LE() < 256 || result.type === 0)) {
      result.data = 'SKIP';
    } else if (result.type === 0x18 || typeBuffer.slice(0, 2).equals(ZLIB_HEADER)) {
      result.data = 'UNKNOWN COMPRESSED DATA';
      state.pos = buffer.indexOf(COMPRESSED_DATA_END, state.pos) + 4;
    } else {
      switch (result.type) {
        case DATA_TYPES.BOOLEAN: result.data = readBoolean(buffer, state); break;
        case DATA_TYPES.INTEGER: result.data = readInt(buffer, state); break;
        case DATA_TYPES.ARRAY_START: result.data = readArray0A(buffer, state); break;
        case 3: result.data = 'UNKNOWN!'; state.pos += 12; break;
        case 0x15:
          result.data = 'UNKNOWN!';
          if (buffer.slice(state.pos, state.pos + 4).equals(Buffer.from([0, 0, 0, 0x80]))) state.pos += 20;
          else state.pos += 12;
          break;
        case 4:
        case DATA_TYPES.STRING: result.data = readString(buffer, state); break;
        case DATA_TYPES.UTF_STRING: result.data = readUtfString(buffer, state); break;
        case 0x14:
        case 0x0d: result.data = 'UNKNOWN!'; state.pos += 16; break;
        case 0x0b: result.data = readArray0B(buffer, state).data; break;
        default: successfulParse = false; state.pos -= 7; break;
      }
    }
  } while (!successfulParse);
  return result;
}

// Reads a 0x0B array. `state.pos` must point 8 bytes past the block marker
// (i.e. at marker + 8), matching pydt's readArray0B contract.
function readArray0B(buffer, state) {
  const result = { data: [], chunks: [] };
  result.chunks.push(buffer.slice(state.pos, state.pos + 8));
  state.pos += 8;
  const arrayLen = buffer.readUInt32LE(state.pos);
  result.chunks.push(buffer.slice(state.pos, state.pos + 4));
  state.pos += 4;

  for (let i = 0; i < arrayLen; i++) {
    if (buffer[state.pos] !== 0x0a) {
      throw new Error(`array element ${i} did not start with 0x0A at offset ${state.pos}`);
    }
    const startPos = state.pos;
    state.pos += 16;
    const curData = {};
    result.data.push(curData);
    let info;
    do {
      state = readState(buffer, state);
      info = parseEntry(buffer, state);
      for (const key in GAME_DATA) {
        if (info.marker.equals(GAME_DATA[key])) curData[key] = info;
      }
    } while (info.data !== '1');
    result.chunks.push(buffer.slice(startPos, state.pos));
  }
  result.endPos = state.pos;
  return result;
}

// ---------------------------------------------------------------------------
// Writers (adapted from pydt).
// ---------------------------------------------------------------------------

function writeString(marker, newValue) {
  const safeValue = iconv.encode(diacritics.remove(newValue), 'ascii');
  const strLenBuffer = Buffer.from([0, 0, 0, 0x21, 1, 0, 0, 0]);
  strLenBuffer.writeUInt16LE(safeValue.length + 1, 0);
  return Buffer.concat([marker, Buffer.from([5, 0, 0, 0]), strLenBuffer, Buffer.from(safeValue), Buffer.from([0])]);
}

function modifyEntryInChunks(subChunks, entry, newValue) {
  const idx = subChunks.indexOf(entry.chunk);
  subChunks[idx] = entry.chunk = writeString(entry.marker, newValue);
}

// ---------------------------------------------------------------------------
// Config-level API.
// ---------------------------------------------------------------------------

function findModBlocks(buffer) {
  const blocks = [];
  for (const key of Object.keys(MOD_BLOCK_MARKERS)) {
    const marker = MOD_BLOCK_MARKERS[key];
    let from = 0;
    let off;
    while ((off = buffer.indexOf(marker, from)) !== -1) {
      // A real block marker is followed by the 0x0B array type.
      if (buffer.readUInt32LE(off + 4) === 0x0b) {
        blocks.push({ key, markerOffset: off });
      }
      from = off + 4;
    }
  }
  blocks.sort((a, b) => a.markerOffset - b.markerOffset);
  return blocks;
}

// Reads one mod block into { key, markerOffset, dataStart, endPos, count, chunks, mods }.
// `dataStart` = markerOffset + 8 (where the array body begins).
// The block's on-disk bytes span [markerOffset, endPos).
function readModBlock(buffer, block) {
  const dataStart = block.markerOffset + 8;
  const state = { pos: dataStart };
  const arr = readArray0B(buffer, state);
  const count = buffer.readUInt32LE(arr.chunks[1].byteOffset);
  const mods = arr.data.map((e) => ({
    id: e.MOD_ID ? e.MOD_ID.data : null,
    title: e.MOD_TITLE ? e.MOD_TITLE.data : null,
  }));
  return {
    key: block.key,
    markerOffset: block.markerOffset,
    dataStart,
    endPos: arr.endPos,
    count,
    chunks: arr.chunks,
    mods,
  };
}

function parseConfig(buffer) {
  const blocks = findModBlocks(buffer).map((b) => readModBlock(buffer, b));
  return { blocks };
}

// Distinct enabled mods across all blocks (deduped, case-insensitive on GUID).
function listMods(buffer) {
  const { blocks } = parseConfig(buffer);
  const seen = new Map();
  for (const b of blocks) {
    for (const m of b.mods) {
      if (!m.id) continue;
      const k = m.id.toLowerCase();
      if (!seen.has(k)) seen.set(k, { id: m.id, title: m.title });
    }
  }
  return { mods: [...seen.values()], blocks };
}

// Rebuild the raw bytes of a block from its chunk list, incrementing/using the
// given element count in the 4-byte count field.
function assembleBlock(buffer, block, chunks, newCount) {
  const marker = buffer.slice(block.markerOffset, block.markerOffset + 8);
  const countBuf = Buffer.from(chunks[1]);
  countBuf.writeUInt32LE(newCount, 0);
  const parts = [marker, chunks[0], countBuf, ...chunks.slice(2)];
  return Buffer.concat(parts);
}

// Add a mod (GUID + title JSON) to every mod block. Returns a new Buffer.
// Splices only the block regions; all other bytes are preserved verbatim.
function addMod(buffer, modId, modTitle) {
  const blocks = findModBlocks(buffer).map((b) => readModBlock(buffer, b)).sort((a, b) => b.markerOffset - a.markerOffset);
  if (blocks.length === 0) throw new Error('no mod blocks found');
  let out = buffer;
  // Edit from the highest offset downward so earlier offsets stay valid.
  for (const block of blocks) {
    if (block.count < 1) continue; // need an existing element to clone
    const template = Buffer.from(block.chunks[block.chunks.length - 1]);
    const newElement = cloneElementWith(template, modId, modTitle);
    const newChunks = [...block.chunks, newElement];
    const newBlockBytes = assembleBlock(buffer, block, newChunks, block.count + 1);
    out = Buffer.concat([out.slice(0, block.markerOffset), newBlockBytes, out.slice(block.endPos)]);
  }
  return out;
}

// Remove a mod (by GUID, case-insensitive) from every mod block.
function removeMod(buffer, modId) {
  const target = modId.toLowerCase();
  const blocks = findModBlocks(buffer).map((b) => readModBlock(buffer, b)).sort((a, b) => b.markerOffset - a.markerOffset);
  let out = buffer;
  for (const block of blocks) {
    const elementChunks = block.chunks.slice(2);
    const keep = [];
    let removed = 0;
    for (const c of elementChunks) {
      const id = readElementModId(c);
      if (id && id.toLowerCase() === target) removed++;
      else keep.push(c);
    }
    if (removed === 0) continue;
    const newChunks = [block.chunks[0], block.chunks[1], ...keep];
    const newBlockBytes = assembleBlock(buffer, block, newChunks, block.count - removed);
    out = Buffer.concat([out.slice(0, block.markerOffset), newBlockBytes, out.slice(block.endPos)]);
  }
  return out;
}

// Clone a single element buffer, replacing its MOD_ID and MOD_TITLE strings.
function cloneElementWith(elementBuf, modId, modTitle) {
  const subChunks = [];
  let state = readState(elementBuf, null);
  let chunkStart = 0;
  while (state) {
    const entry = parseEntry(elementBuf, state);
    entry.chunk = elementBuf.slice(chunkStart, state.pos);
    subChunks.push(entry.chunk);
    chunkStart = state.pos;
    if (entry.marker.equals(MOD_ID)) modifyEntryInChunks(subChunks, entry, modId);
    else if (entry.marker.equals(MOD_TITLE)) modifyEntryInChunks(subChunks, entry, modTitle);
    state = readState(elementBuf, state);
  }
  return Buffer.concat(subChunks);
}

// Read just the MOD_ID string from a single element buffer.
function readElementModId(elementBuf) {
  let state = readState(elementBuf, null);
  while (state) {
    const save = state.pos;
    const entry = parseEntry(elementBuf, state);
    if (entry.marker.equals(MOD_ID) && typeof entry.data === 'string') return entry.data;
    if (state.pos <= save) break;
    state = readState(elementBuf, state);
  }
  return null;
}

module.exports = {
  MOD_BLOCK_MARKERS,
  findModBlocks,
  readModBlock,
  parseConfig,
  listMods,
  addMod,
  removeMod,
};
