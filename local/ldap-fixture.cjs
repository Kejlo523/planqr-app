const { createRequire } = require('node:module');
const { join } = require('node:path');

module.exports = function startFixtureLdap(port, host, password, additionalAdmin = {}) {
    if (!password) throw new Error('A fixture LDAP password is required');
    const ldap = createRequire(join(process.cwd(), 'package.json'))('ldapjs');
    const directory = ldap.createServer();
    const users = {
        'pilot-admin': { givenName: 'Testowy', sn: 'Prowadzacy', title: 'teacher' },
        'lecturer-two': { givenName: 'Testowy', sn: 'Drugi', title: 'teacher' },
    };
    const adminLogin = additionalAdmin.login?.trim().toLowerCase();
    if (adminLogin || additionalAdmin.password) {
        if (!adminLogin || !/^[a-z][a-z0-9.-]{0,62}$/.test(adminLogin) || Object.hasOwn(users, adminLogin) || !additionalAdmin.password) {
            throw new Error('The additional fixture admin needs a distinct login and password');
        }
        users[adminLogin] = { givenName: adminLogin, sn: 'Administrator', title: 'teacher' };
    }
    const base = 'dc=localhost';
    const entries = new Map(Object.entries(users).map(([uid, attrs]) => [
        'uid=' + uid + ',' + base, { uid, ...attrs },
    ]));
    directory.bind(base, (req, res, next) => {
        const dn = req.dn.toString().toLowerCase();
        const entry = entries.get(dn);
        if (!entry || req.credentials !== (entry.uid === adminLogin ? additionalAdmin.password : password)) {
            return next(new ldap.InvalidCredentialsError());
        }
        res.end();
        return next();
    });
    directory.search(base, (req, res, next) => {
        res.attributes = res.attributes.map((attribute) => attribute.toLowerCase());
        for (const [dn, attributes] of entries) {
            if (req.filter.matches(attributes)) res.send({ dn, attributes });
        }
        res.end();
        return next();
    });
    directory.listen(port, host, () => console.log('Fixture LDAP listening on port', port));
};
