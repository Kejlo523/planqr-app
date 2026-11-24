export function normalizeCardAlias(value: string) {
    const alias = value.normalize('NFKC').trim().toUpperCase();
    const wisync = /^WI[\s_-]*SYNC[\s_-]*(\d+)$/.exec(alias);
    return wisync ? 'WISYNC_' + wisync[1] : alias;
}

export function cardAliasKeys(value: string) {
    return [...new Set([
        normalizeCardAlias(value), value.trim().toUpperCase(), normalizeCardAlias(normalizeCardLogin(value)),
    ])];
}

export function normalizeCardLogin(value: string) {
    const login = value.normalize('NFKC').trim().toLowerCase();
    return /^([^@\s]+)@(?:[a-z0-9-]+\.)*zut\.edu\.pl$/.exec(login)?.[1] ?? login;
}
