export function validateSingleRecipient(value: string): string {
  const recipient = value.trim();
  if (recipient.includes(',')) {
    throw new Error('agent-mail --to accepts one agent. Send one message per recipient; comma-separated recipients are not supported.');
  }
  return recipient;
}
