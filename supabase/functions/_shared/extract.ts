// Text extraction for Knowledge Base uploads: plain text formats, PDF (unpdf,
// text layer only — scanned PDFs have none) and Word .docx (the document XML).

import { extractText, getDocumentProxy } from 'npm:unpdf@0.12.1';
import { strFromU8, unzipSync } from 'npm:fflate@0.8.2';

export type DocKind = 'text' | 'markdown' | 'pdf' | 'docx' | 'code' | 'csv' | 'json';

const CODE = /\.(js|jsx|ts|tsx|py|dart|java|kt|swift|go|rs|rb|php|c|h|cpp|hpp|cs|sql|sh|ya?ml|toml|xml|html?|css|scss)$/i;

export function kindFor(name: string): DocKind | null {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.docx')) return 'docx';
  if (/\.(md|markdown)$/.test(n)) return 'markdown';
  if (n.endsWith('.csv') || n.endsWith('.tsv')) return 'csv';
  if (n.endsWith('.json')) return 'json';
  if (CODE.test(n)) return 'code';
  if (/\.(txt|text|log|rst|srt)$/.test(n) || !n.includes('.')) return 'text';
  return null;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export function docxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('This .docx file has no document text.');
  return decodeXml(
    strFromU8(xml)
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\n{3,}/g, '\n\n').trim();
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((page) => String(page).trim()).filter(Boolean).join('\n\n');
}

/** Text of an uploaded file. Throws a user-facing message when it can't be read. */
export async function extract(kind: DocKind, bytes: Uint8Array): Promise<string> {
  if (kind === 'pdf') {
    const text = await pdfText(bytes).catch(() => {
      throw new Error("This PDF couldn't be read.");
    });
    if (text.replace(/\s/g, '').length < 20) throw new Error('This PDF has no text layer (it may be a scan). Upload a text PDF or paste the text.');
    return text;
  }
  if (kind === 'docx') return docxText(bytes);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.includes('\u0000')) throw new Error('This looks like a binary file, not text.');
  return text;
}
