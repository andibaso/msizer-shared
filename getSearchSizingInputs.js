// getSearchSizingInputs.js
// Collects Search Sizing inputs from search / vector index definitions plus a
// random document sample. Reads metadata and $sample only; writes nothing.
// Run: mongosh "<connection-string>" --quiet getSearchSizingInputs.js > search_inputs.json
if (typeof _sampleSize === "undefined") var _sampleSize = 1000;

const round = (x) => Math.round(x * 100) / 100;
const isDoc = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !v._bsontype;
const binLen = (v) => (typeof v.length === "function" ? v.length() : v.buffer.length);

function valueInfo(v) {
  if (typeof v === "string") return ["String", Buffer.byteLength(v, "utf8")];
  if (typeof v === "boolean") return ["Boolean", 1];
  if (typeof v === "number") return ["Number", 8];
  if (v instanceof Date) return ["Date", 8];
  switch (v && v._bsontype) {
    case "Long": case "Double": return ["Number", 8];
    case "Int32": return ["Number", 4];
    case "Decimal128": return ["Number", 16];
    case "ObjectId": return ["ObjectId", 12];
    case "Binary": return [v.sub_type === 4 ? "UUID" : "Binary", binLen(v)];
  }
  return ["Other", 0];
}

// Leaf values at a dotted path, descending through arrays
function valuesAt(obj, parts) {
  if (obj === undefined || obj === null) return [];
  if (Array.isArray(obj)) return obj.flatMap((o) => valuesAt(o, parts));
  if (parts.length === 0) return [obj];
  if (!isDoc(obj)) return [];
  return valuesAt(obj[parts[0]], parts.slice(1));
}

function rawAt(obj, parts) {
  for (const p of parts) { if (!isDoc(obj)) return undefined; obj = obj[p]; }
  return obj;
}

function leafPaths(obj, prefix, acc) {
  if (Array.isArray(obj)) { obj.forEach((e) => leafPaths(e, prefix, acc)); return; }
  if (isDoc(obj)) {
    for (const k of Object.keys(obj)) if (prefix || k !== "_id") leafPaths(obj[k], prefix ? prefix + "." + k : k, acc);
    return;
  }
  if (prefix && obj !== null && obj !== undefined) acc.add(prefix);
}

function mappedFields(def) {
  const out = [];
  const m = def.mappings || {};
  if (m.dynamic) out.push({ path: "", dynamic: true });
  (function walk(fields, prefix) {
    for (const [name, spec] of Object.entries(fields || {})) {
      const path = prefix ? prefix + "." + name : name;
      for (const s of [].concat(spec)) {
        if (s.type === "document" || s.type === "embeddedDocuments") {
          if (s.dynamic) out.push({ path, dynamic: true });
          if (s.type === "embeddedDocuments") out.push({ path, embedded: true });
          walk(s.fields, path);
        } else out.push({ path, type: s.type, analyzer: s.analyzer || null });
      }
    }
  })(m.fields, "");
  return out;
}

function measureSearch(docs, def) {
  if (!docs.length) return {};
  const paths = new Map();
  const embedded = [];
  const add = (p, t, a) => {
    if (!paths.has(p)) paths.set(p, { mappedAs: new Set(), analyzers: new Set() });
    if (t) paths.get(p).mappedAs.add(t);
    if (a) paths.get(p).analyzers.add(a);
  };
  for (const f of mappedFields(def)) {
    if (f.embedded) { embedded.push(f.path); continue; }
    if (f.dynamic) {
      const acc = new Set();
      docs.forEach((d) => f.path
        ? valuesAt(d, f.path.split(".")).forEach((v) => leafPaths(v, f.path, acc))
        : leafPaths(d, "", acc));
      acc.forEach((p) => add(p, "dynamic", null));
    } else add(f.path, f.type, f.analyzer);
  }
  const fields = [];
  for (const [path, meta] of paths) {
    let docsWith = 0, nValues = 0, bytes = 0;
    const seen = {};
    for (const d of docs) {
      const vals = valuesAt(d, path.split("."));
      if (vals.length) docsWith++;
      for (const v of vals) { const [t, b] = valueInfo(v); seen[t] = (seen[t] || 0) + 1; nValues++; bytes += b; }
    }
    fields.push({
      path,
      mappedAs: [...meta.mappedAs],
      analyzers: [...meta.analyzers],
      bsonType: Object.keys(seen).sort((a, b) => seen[b] - seen[a])[0] || "missing",
      typesSeen: seen,
      pctDocsWithField: round((100 * docsWith) / docs.length),
      avgValuesPerDoc: round(nValues / docs.length),
      avgBytesPerDoc: round(bytes / docs.length),
    });
  }
  const fieldsByType = {};
  for (const f of fields) {
    const t = fieldsByType[f.bsonType] || (fieldsByType[f.bsonType] = { fields: 0, valuesPerDoc: 0, avgBytesPerDoc: 0 });
    t.fields++;
    t.valuesPerDoc = round(t.valuesPerDoc + f.avgValuesPerDoc);
    t.avgBytesPerDoc = round(t.avgBytesPerDoc + f.avgBytesPerDoc);
  }
  let indexedDocs = 0, luceneDocs = 0;
  const keys = [...paths.keys()];
  for (const d of docs) {
    if (keys.some((p) => valuesAt(d, p.split(".")).length)) indexedDocs++;
    luceneDocs += 1 + embedded.reduce((s, p) => s + valuesAt(d, p.split(".")).length, 0);
  }
  return {
    pctDocsWithIndexedFields: round((100 * indexedDocs) / docs.length),
    avgLuceneDocsPerDoc: round(luceneDocs / docs.length),
    fieldsByType,
    fields,
  };
}

function vectorInfo(v) {
  if (Array.isArray(v)) return { format: "array of numbers (float)", dims: v.length, bytes: v.length * 8 };
  if (v && v._bsontype === "Binary" && v.sub_type === 9) {
    const b = v.buffer, len = binLen(v);
    if (b[0] === 0x27) return { format: "BinData float32", dims: (len - 2) / 4, bytes: len };
    if (b[0] === 0x03) return { format: "BinData int8", dims: len - 2, bytes: len };
    if (b[0] === 0x10) return { format: "BinData int1 (packed bit)", dims: (len - 2) * 8 - b[1], bytes: len };
  }
  return { format: "other", dims: null, bytes: 0 };
}

function measureVector(docs, def) {
  if (!docs.length) return [];
  return (def.fields || []).map((f) => {
    if (f.type === "vector") {
      let n = 0, dims = null, bytes = 0;
      const formats = {};
      for (const d of docs) {
        const v = rawAt(d, f.path.split("."));
        if (v === undefined || v === null) continue;
        const i = vectorInfo(v);
        n++; bytes += i.bytes; dims = dims === null ? i.dims : dims;
        formats[i.format] = (formats[i.format] || 0) + 1;
      }
      return {
        path: f.path, type: "vector", numDimensions: f.numDimensions, similarity: f.similarity,
        quantization: f.quantization || "none", storedFormat: formats, observedDims: dims,
        pctDocsWithVector: round((100 * n) / docs.length), avgStoredBytes: n ? round(bytes / n) : 0,
      };
    }
    let bytes = 0;
    const seen = {};
    for (const d of docs) for (const v of valuesAt(d, f.path.split("."))) {
      const [t, b] = valueInfo(v); seen[t] = (seen[t] || 0) + 1; bytes += b;
    }
    return { path: f.path, type: f.type, typesSeen: seen, avgBytesPerDoc: round(bytes / docs.length) };
  });
}

const out = { scriptTs: new Date(), sampleSize: _sampleSize, indexes: [], errors: [] };
db.getMongo().getDBNames()
  .filter((n) => !/^(admin|local|config|__mdb_internal_search)$/.test(n))
  .forEach((dbName) => {
    const sdb = db.getSiblingDB(dbName);
    sdb.getCollectionInfos({}, { nameOnly: true }).forEach(({ name }) => {
      if (name.startsWith("system.")) return;
      const ns = dbName + "." + name;
      try {
        const coll = sdb.getCollection(name);
        const defs = coll.aggregate([{ $listSearchIndexes: {} }]).toArray();
        if (!defs.length) return;
        const docs = coll.aggregate([{ $sample: { size: _sampleSize } }], { allowDiskUse: true }).toArray();
        const est = coll.estimatedDocumentCount();
        for (const ix of defs) {
          const def = ix.latestDefinition || ix.definition || {};
          const rec = {
            ns, index: ix.name, type: ix.type || ((def && Array.isArray(def.fields) && def.fields.some(f => f && f.type === "vector")) ? "vectorSearch" : "search"), status: ix.status, queryable: ix.queryable,
            estimatedDocumentCount: est, sampledDocs: docs.length, definition: def,
          };
          if (rec.type === "vectorSearch") rec.vectorFields = measureVector(docs, def);
          else Object.assign(rec, measureSearch(docs, def));
          out.indexes.push(rec);
        }
      } catch (e) {
        out.errors.push({ ns, error: e.message });
      }
    });
  });
print(EJSON.stringify(out, null, 2, { relaxed: true }));
