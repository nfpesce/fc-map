/*
 * Minimal RFC 4180 streaming CSV parser for the browser.
 * Matches the csv-parse options previously used on the server:
 * bom: true, columns: true (first row = headers), skip_empty_lines: true,
 * relax_column_count: true. Handles quoted fields, escaped quotes ("") and
 * CRLF / LF line endings, including records split across chunks.
 */

export type CsvRowHandler = (row: string[]) => void;

export class CsvStreamParser {
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  private quotePending = false; // saw a quote while inside a quoted field
  private fieldStarted = false;
  private pendingCR = false;
  private first = true;

  constructor(private readonly onRow: CsvRowHandler) {}

  push(chunk: string) {
    let text = chunk;
    if (this.first) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (text.length) this.first = false;
    }
    const length = text.length;
    let index = 0;
    while (index < length) {
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          if (text.charCodeAt(index) === 34) {
            this.field += '"';
            index += 1;
            continue;
          }
          this.inQuotes = false;
          continue; // re-evaluate this char as unquoted
        }
        const nextQuote = text.indexOf('"', index);
        if (nextQuote === -1) {
          this.field += text.slice(index);
          index = length;
        } else {
          this.field += text.slice(index, nextQuote);
          this.quotePending = true;
          index = nextQuote + 1;
        }
        continue;
      }

      const code = text.charCodeAt(index);
      if (this.pendingCR) {
        this.pendingCR = false;
        if (code === 10) {
          index += 1;
          continue;
        }
      }
      if (code === 44) { // ,
        this.row.push(this.field);
        this.field = "";
        this.fieldStarted = true;
        index += 1;
      } else if (code === 10 || code === 13) { // \n or \r
        this.endRecord();
        if (code === 13) this.pendingCR = true;
        index += 1;
      } else if (code === 34 && this.field.length === 0) { // opening quote
        this.inQuotes = true;
        this.fieldStarted = true;
        index += 1;
      } else {
        // fast path: consume until next delimiter/newline/quote
        let end = index + 1;
        while (end < length) {
          const next = text.charCodeAt(end);
          if (next === 44 || next === 10 || next === 13) break;
          end += 1;
        }
        this.field += text.slice(index, end);
        this.fieldStarted = true;
        index = end;
      }
    }
  }

  finish() {
    if (this.inQuotes && !this.quotePending) throw new Error("The CSV file ends inside a quoted field.");
    this.inQuotes = false;
    this.quotePending = false;
    this.endRecord();
  }

  private endRecord() {
    if (!this.fieldStarted && this.row.length === 0 && this.field.length === 0) return; // empty line
    this.row.push(this.field);
    this.onRow(this.row);
    this.row = [];
    this.field = "";
    this.fieldStarted = false;
  }
}

/** Parses a CSV byte stream, calling onHeader once and onRecord for every data row. */
export async function parseCsvByteStream(
  stream: ReadableStream<Uint8Array>,
  handlers: { onHeader: (headers: string[]) => void; onRecord: CsvRowHandler; onProgress?: (bytesRead: number) => void },
) {
  let headers: string[] | null = null;
  const parser = new CsvStreamParser((row) => {
    if (!headers) {
      headers = row;
      handlers.onHeader(row);
      return;
    }
    handlers.onRecord(row);
  });
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();
  let bytesRead = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    parser.push(decoder.decode(value, { stream: true }));
    handlers.onProgress?.(bytesRead);
  }
  const tail = decoder.decode();
  if (tail) parser.push(tail);
  parser.finish();
  if (!headers) throw new Error("The CSV file does not contain any records.");
}
