export function parseProviderHostRules(value: string | undefined): string[] {
  return (value ?? '').split(',').map(rule => rule.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
}

export function providerHostAllowed(hostname: string, rules: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return rules.some(rule => rule.startsWith('*.')
    ? host !== rule.slice(2) && host.endsWith(`.${rule.slice(2)}`)
    : host === rule);
}
