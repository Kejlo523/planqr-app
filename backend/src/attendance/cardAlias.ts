export function normalizeCardAlias(value: string) {
    const alias = value.normalize('NFKC').trim().toUpperCase();
    const wisync = /^WI[\s_-]*SYNC[\s_-]*(\d+)$/.exec(alias);
    return wisync ? 'WISYNC_' + wisync[1] : alias;
}

export function cardAliasKeys(value: string) {
    return [...new Set([normalizeCardAlias(value), value.trim().toUpperCase()])];
}
