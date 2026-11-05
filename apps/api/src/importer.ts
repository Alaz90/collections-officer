import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Borrower, Loan } from '@co/shared';
import { addDays } from './domain/dates.js';

/**
 * Loan book import from whatever spreadsheet the lender already has.
 * Gemini proposes which column means what; the lender confirms; code does
 * the conversion and reports every row it could not read.
 */

export const FIELDS = ['name', 'phone', 'email', 'region', 'sector', 'principal', 'instalment', 'firstDueDate', 'instalments', 'paid'] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, string>>;

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  const [headers = [], ...data] = rows;
  return { headers, rows: data };
}

const HINTS: Record<Field, RegExp> = {
  name: /name|borrower|client|customer|ስም/i,
  phone: /phone|mobile|tel|ስልክ/i,
  email: /e-?mail/i,
  region: /region|area|location|kebele|woreda|zone|city|ክልል/i,
  sector: /sector|business|activity|occupation|type/i,
  principal: /principal|loan amount|amount borrowed|disbursed|loan$/i,
  instalment: /instal|install|monthly|repayment amount|emi/i,
  firstDueDate: /due|first payment|start/i,
  instalments: /term|months|number of|count|tenor|period/i,
  paid: /paid|repaid|collected/i,
};

export function guessMapping(headers: string[]): Mapping {
  const used = new Set<string>();
  const m: Mapping = {};
  for (const f of FIELDS) {
    const h = headers.find((x) => !used.has(x) && HINTS[f].test(x));
    if (h) {
      m[f] = h;
      used.add(h);
    }
  }
  return m;
}

const MappingSchema = z.object(Object.fromEntries(FIELDS.map((f) => [f, z.string().nullable()])) as Record<Field, z.ZodNullable<z.ZodString>>);

export async function suggestMapping(headers: string[], sample: string[][], gemini?: { apiKey: string; model: string }): Promise<{ mapping: Mapping; by: 'gemini' | 'rules' }> {
  if (gemini) {
    try {
      const client = new GoogleGenAI({ apiKey: gemini.apiKey });
      const res = await client.models.generateContent({
        model: gemini.model,
        contents: `Spreadsheet headers: ${JSON.stringify(headers)}\nSample rows: ${JSON.stringify(sample.slice(0, 5))}\nFor each field (${FIELDS.join(', ')}), return the exact header that holds it, or null. principal = total loan amount; instalment = amount per payment; firstDueDate = first repayment date; instalments = number of payments; paid = amount repaid so far; sector = farming, trade, salaried or other.`,
        config: { responseMimeType: 'application/json', responseJsonSchema: zodToJsonSchema(MappingSchema, { target: 'openApi3', $refStrategy: 'none' }), temperature: 0 },
      });
      const parsed = MappingSchema.safeParse(JSON.parse(res.text ?? '{}'));
      if (parsed.success) {
        const m: Mapping = {};
        for (const f of FIELDS) {
          const h = parsed.data[f];
          if (h && headers.includes(h)) m[f] = h;
        }
        return { mapping: m, by: 'gemini' };
      }
    } catch {
      // fall back to rules
    }
  }
  return { mapping: guessMapping(headers), by: 'rules' };
}

function toCents(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

function toDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function toSector(s: string | undefined): Borrower['sector'] {
  const v = (s ?? '').toLowerCase();
  if (/farm|agri|crop|coffee|teff|livestock/.test(v)) return 'farming';
  if (/trade|shop|retail|merchant|market/.test(v)) return 'trade';
  if (/salar|employ|civil|teacher/.test(v)) return 'salaried';
  return 'other';
}

export function convert(
  lenderId: string,
  csv: { headers: string[]; rows: string[][] },
  mapping: Mapping,
  ids: () => string,
): { borrowers: Borrower[]; loans: Loan[]; problems: Array<{ row: number; reason: string }> } {
  const col = (f: Field) => (mapping[f] ? csv.headers.indexOf(mapping[f]!) : -1);
  const get = (row: string[], f: Field) => (col(f) >= 0 ? row[col(f)] : undefined);
  const borrowers: Borrower[] = [];
  const loans: Loan[] = [];
  const problems: Array<{ row: number; reason: string }> = [];

  csv.rows.forEach((row, i) => {
    const name = get(row, 'name');
    const first = toDate(get(row, 'firstDueDate'));
    const principal = toCents(get(row, 'principal'));
    let instalment = toCents(get(row, 'instalment'));
    let count = Number(get(row, 'instalments')) || 0;
    if (!count && principal && instalment) count = Math.round(principal / instalment);
    if (!instalment && principal && count) instalment = Math.round(principal / count);
    if (!name) return problems.push({ row: i + 2, reason: 'no borrower name' });
    if (!first) return problems.push({ row: i + 2, reason: 'no readable first due date' });
    if (!instalment || !count) return problems.push({ row: i + 2, reason: 'need the instalment amount or the loan amount and term' });

    let paid = toCents(get(row, 'paid')) ?? 0;
    const schedule = Array.from({ length: count }, (_, k) => {
      const take = Math.min(paid, instalment!);
      paid -= take;
      return { dueDate: addDays(first, 30 * k), amountCents: instalment!, paidCents: take };
    });
    const borrowerId = ids();
    borrowers.push({
      id: borrowerId,
      lenderId,
      name,
      phone: get(row, 'phone') || undefined,
      email: get(row, 'email') || undefined,
      preferredChannel: 'telegram',
      language: 'en',
      region: get(row, 'region') || 'Unknown',
      sector: toSector(get(row, 'sector')),
      incomePattern: toSector(get(row, 'sector')) === 'farming' ? 'harvest' : 'monthly',
      optedOut: false,
      caseSummary: '',
    });
    loans.push({
      id: ids(),
      lenderId,
      borrowerId,
      principalCents: principal ?? instalment * count,
      schedule,
      status: 'current',
      rescheduleCount: 0,
      hold: null,
      createdAt: addDays(first, -30),
    });
  });
  return { borrowers, loans, problems };
}
