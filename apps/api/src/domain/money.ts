export function formatBirr(cents: number): string {
  const birr = cents / 100;
  const text = birr.toLocaleString('en-US', { minimumFractionDigits: birr % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return `${text} birr`;
}
