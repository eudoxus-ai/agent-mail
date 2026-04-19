export function buildApprovalUrl(port: number, intentId: string): string {
  return `http://127.0.0.1:${port}/intents/${intentId}`;
}
