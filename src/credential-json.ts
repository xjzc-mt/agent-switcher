const invalid = () => new Error('凭据 JSON 语法不完整或分隔方式无法识别，请检查括号、引号及对象之间的内容');
class DuplicateFieldError extends Error {
  constructor() { super('同一个 JSON 对象中出现重复字段，无法确定应使用哪份内容，请拆分为独立账号'); }
}

function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  throw invalid();
}

/** JSON.parse is authoritative. Check duplicate keys before its last-write-wins result is used. */
function strict(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{' || char === '[') {
      stack.push(char === '{' ? new Set() : null);
      if (stack.length > 256) throw new Error('JSON 结构过于复杂，请精简后导入');
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const end = stringEnd(text, i);
      let next = end;
      while (/\s/.test(text[next] || '') && next < text.length) next++;
      const keys = stack.at(-1);
      if (keys && text[next] === ':') {
        const key: string = JSON.parse(text.slice(i, end));
        if (keys.has(key)) throw new DuplicateFieldError();
        keys.add(key);
      }
      i = end - 1;
    }
  }
  return value;
}

/** Only comments and trailing commas outside strings can be removed. No token text is rewritten. */
function jsonWithComments(text: string): string {
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { i = stringEnd(text, i) - 1; continue; }
    if (text[i] !== '/' || !['/', '*'].includes(text[i + 1])) continue;
    chunks.push(text.slice(start, i), ' ');
    if (text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2);
      i = end < 0 ? text.length : end;
    } else {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw invalid();
      i = end + 1;
    }
    start = i + 1;
  }
  chunks.push(text.slice(start));
  const clean = chunks.join('');
  const result: string[] = [];
  start = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '"') { i = stringEnd(clean, i) - 1; continue; }
    if (clean[i] !== ',') continue;
    let next = i + 1;
    while (next < clean.length && /\s/.test(clean[next])) next++;
    if (clean[next] === '}' || clean[next] === ']') { result.push(clean.slice(start, i)); start = i + 1; }
  }
  result.push(clean.slice(start));
  return result.join('');
}

/** Read complete top-level objects/arrays, respecting string escapes and nesting. */
function sequence(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  const space = () => { while (i < text.length && /[\s\u001e]/.test(text[i])) i++; };
  space();
  while (i < text.length) {
    if (text[i] !== '{' && text[i] !== '[') throw invalid();
    const start = i, stack: string[] = [];
    for (; i < text.length; i++) {
      const char = text[i];
      if (char === '"') { i = stringEnd(text, i) - 1; continue; }
      if (char === '{' || char === '[') {
        stack.push(char);
        if (stack.length > 256) throw new Error('JSON 结构过于复杂，请精简后导入');
      } else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) throw invalid();
        if (!stack.length) { i++; break; }
      }
    }
    if (stack.length) throw invalid();
    values.push(strict(text.slice(start, i)));
    if (values.length > 200) throw new Error('一次最多导入 200 个账号');
    space();
    if (text[i] === ',') { i++; space(); if (i === text.length) throw invalid(); }
  }
  if (!values.length) throw invalid();
  return values;
}

function source(text: string): unknown {
  try { return strict(text); } catch (error) { if (error instanceof DuplicateFieldError) throw error; }
  const clean = jsonWithComments(text);
  if (clean !== text) {
    try { return strict(clean); } catch (error) { if (error instanceof DuplicateFieldError) throw error; }
  }
  return sequence(clean);
}

/** Standard JSON first, then only explicitly bounded text formats; never scavenge arbitrary prose. */
export function parseCredentialJson(input: string): unknown {
  const text = input.replace(/^\uFEFF/, '').trim();
  if (!/^(?:```|~~~)/.test(text)) return source(text);
  const lines = text.split(/\r?\n/), blocks: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const opening = lines[i].trim().match(/^(`{3,}|~{3,})(?:json|jsonc|jsonl|ndjson)?\s*$/i);
    if (!opening) throw invalid();
    const start = ++i;
    while (i < lines.length && lines[i].trim() !== opening[1]) i++;
    if (i === lines.length) throw invalid();
    blocks.push(source(lines.slice(start, i).join('\n')));
    if (blocks.length > 200) throw new Error('一次最多导入 200 个账号');
  }
  if (!blocks.length) throw invalid();
  return blocks.length === 1 ? blocks[0] : blocks;
}
