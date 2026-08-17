'use strict';
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('./git-sync-watch');

const CFG = { nodePath: '/usr/bin/node', scriptPath: '/srv/git-sync-watch', configPath: '/etc/gsw.ini', gitPath: '/usr/bin/git', sshSock: '/tmp/ssh.sock' };
const DEFAULTS = { watchInterval: 3, pullInterval: 300, conflict: 'abort', pullAfterPush: true };

let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gsw-test-')); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('parseIni', () => {
  test('empty input', () => {
    assert.deepEqual(m.parseIni(''), { defaults: {}, watches: [] });
  });

  test('comment and blank lines ignored', () => {
    const out = m.parseIni('; c\n# c\n[defaults]\n# in section\nwatch-interval = 3\n\npull-interval = 300\n; trailing');
    assert.deepEqual(out.defaults, { 'watch-interval': '3', 'pull-interval': '300' });
    assert.deepEqual(out.watches, []);
  });

  test('defaults raw string values', () => {
    const out = m.parseIni('[defaults]\nwatch-interval = 3\npull-interval = 300\nconflict = abort\npull-after-push = true');
    assert.deepEqual(out.defaults, {
      'watch-interval': '3', 'pull-interval': '300', conflict: 'abort', 'pull-after-push': 'true',
    });
  });

  test('spacing variants trimmed', () => {
    const out = m.parseIni('[defaults]\nwatch-interval = 3 \nkey=value\n  spaced =  x  ');
    assert.deepEqual(out.defaults, { 'watch-interval': '3', key: 'value', spaced: 'x' });
  });

  test('lines before any section dropped', () => {
    const out = m.parseIni('foo = bar\n[defaults]\nwatch-interval = 3');
    assert.deepEqual(out.defaults, { 'watch-interval': '3' });
    assert.deepEqual(out.watches, []);
  });

  test('watch section captured with _section and keys', () => {
    const out = m.parseIni('[watch-1]\npath = /x');
    assert.equal(out.watches.length, 1);
    assert.equal(out.watches[0]._section, 'watch-1');
    assert.deepEqual(out.watches[0].keys, { path: '/x' });
  });

  test('non-numeric watch section ignored', () => {
    const out = m.parseIni('[watch-abc]\npath = /x\n[defaults]\nwatch-interval = 3');
    assert.deepEqual(out.watches, []);
    assert.deepEqual(out.defaults, { 'watch-interval': '3' });
  });

  test('unknown default key preserved raw', () => {
    const out = m.parseIni('[defaults]\nother = 1\nwatch-interval = 3');
    assert.deepEqual(out.defaults, { other: '1', 'watch-interval': '3' });
  });

  test('two watch sections order preserved', () => {
    const out = m.parseIni('[watch-1]\npath = /a\n[watch-2]\npath = /b');
    assert.equal(out.watches.length, 2);
    assert.equal(out.watches[0]._section, 'watch-1');
    assert.equal(out.watches[0].keys.path, '/a');
    assert.equal(out.watches[1]._section, 'watch-2');
    assert.equal(out.watches[1].keys.path, '/b');
  });

  test('non-sequential watch id accepted', () => {
    const out = m.parseIni('[watch-5]\npath = /x');
    assert.equal(out.watches.length, 1);
    assert.equal(out.watches[0]._section, 'watch-5');
  });
});

describe('resolveConfigModel', () => {
  function rawModel(defaults, watches) {
    return { defaults: defaults || {}, watches: watches || [] };
  }

  test('empty raw uses built-in fallbacks', () => {
    assert.deepEqual(m.resolveConfigModel(rawModel()), { defaults: DEFAULTS, watches: [] });
  });

  test('invalid intervals fall back', () => {
    assert.equal(m.resolveConfigModel(rawModel({ 'watch-interval': '0' })).defaults.watchInterval, 3);
    assert.equal(m.resolveConfigModel(rawModel({ 'pull-interval': '1.5' })).defaults.pullInterval, 300);
    const d = m.resolveConfigModel(rawModel({ 'watch-interval': '2', 'pull-interval': '2' })).defaults;
    assert.equal(d.watchInterval, 2);
    assert.equal(d.pullInterval, 2);
  });

  test('conflict policy resolved', () => {
    assert.equal(m.resolveConfigModel(rawModel({ conflict: 'remote' })).defaults.conflict, 'remote');
    assert.equal(m.resolveConfigModel(rawModel({ conflict: 'bogus' })).defaults.conflict, 'abort');
  });

  test('pull-after-push bool resolved', () => {
    assert.equal(m.resolveConfigModel(rawModel({ 'pull-after-push': 'false' })).defaults.pullAfterPush, false);
    assert.equal(m.resolveConfigModel(rawModel({ 'pull-after-push': 'yes' })).defaults.pullAfterPush, true);
  });

  test('watch with only path', () => {
    const out = m.resolveConfigModel(rawModel({}, [{ _section: 'watch-1', keys: { path: '/x' } }]));
    assert.deepEqual(out.watches, [{ path: '/x', explicit: {} }]);
  });

  test('watch with all five optional keys', () => {
    const out = m.resolveConfigModel(rawModel({}, [{
      _section: 'watch-1',
      keys: { path: '/x', branch: 'dev', 'pull-interval': '60', 'watch-interval': '7', conflict: 'force-local', 'pull-after-push': 'false' },
    }]));
    assert.deepEqual(out.watches, [{
      path: '/x',
      explicit: { branch: true, pullInterval: true, watchInterval: true, conflict: true, pullAfterPush: true },
      branch: 'dev', pullInterval: 60, watchInterval: 7, conflict: 'force-local', pullAfterPush: false,
    }]);
  });

  test('watch without path dropped', () => {
    const out = m.resolveConfigModel(rawModel({}, [{ _section: 'watch-1', keys: { branch: 'dev' } }]));
    assert.deepEqual(out.watches, []);
  });

  test('explicit pull-interval 0 resolves to default but stays explicit', () => {
    const out = m.resolveConfigModel(rawModel({}, [{ _section: 'watch-1', keys: { path: '/x', 'pull-interval': '0' } }]));
    assert.equal(out.watches.length, 1);
    assert.equal(out.watches[0].pullInterval, 300);
    assert.equal(out.watches[0].explicit.pullInterval, true);
  });

  test('explicit pull-after-push false', () => {
    const out = m.resolveConfigModel(rawModel({}, [{ _section: 'watch-1', keys: { path: '/x', 'pull-after-push': 'false' } }]));
    assert.equal(out.watches.length, 1);
    assert.equal(out.watches[0].pullAfterPush, false);
    assert.equal(out.watches[0].explicit.pullAfterPush, true);
  });
});

describe('serializeIni', () => {
  test('canonical model', () => {
    const model = {
      defaults: DEFAULTS,
      watches: [{ path: '/x', explicit: { branch: true }, branch: 'main' }],
    };
    const expected = [
      '; git-sync-watch config',
      '[defaults]',
      'watch-interval = 3',
      'pull-interval = 300',
      'conflict = abort',
      'pull-after-push = true',
      '',
      '[watch-1]',
      'path = /x',
      'branch = main',
      '',
    ].join('\n');
    assert.equal(m.serializeIni(model), expected);
  });

  test('round-trip two-watch model with mixed explicit keys', () => {
    const model = {
      defaults: DEFAULTS,
      watches: [
        { path: '/a', explicit: { branch: true, conflict: true }, branch: 'dev', conflict: 'remote' },
        { path: '/b', explicit: { branch: true, pullInterval: true, watchInterval: true, conflict: true, pullAfterPush: true }, branch: 'main', pullInterval: 60, watchInterval: 7, conflict: 'force-local', pullAfterPush: false },
      ],
    };
    assert.deepEqual(m.resolveConfigModel(m.parseIni(m.serializeIni(model))), model);
  });

  test('watch sections renumbered in array order', () => {
    const model = {
      defaults: DEFAULTS,
      watches: [{ path: '/a', explicit: {} }, { path: '/b', explicit: {} }],
    };
    const out = m.serializeIni(model);
    const i1 = out.indexOf('[watch-1]');
    const i2 = out.indexOf('[watch-2]');
    assert.ok(i1 !== -1 && i2 !== -1 && i1 < i2);
    assert.equal(out.indexOf('[watch-3]'), -1);
    assert.ok(i1 < out.indexOf('path = /a'));
    assert.ok(i2 < out.indexOf('path = /b'));
  });

  test('non-explicit keys omitted', () => {
    const model = { defaults: DEFAULTS, watches: [{ path: '/x', explicit: {} }] };
    const out = m.serializeIni(model);
    const lines = out.split('\n');
    const i = lines.indexOf('[watch-1]');
    assert.ok(i !== -1);
    assert.equal(lines[i + 1], 'path = /x');
    assert.equal(lines[i + 2], '');
  });
});

describe('effectiveFolder', () => {
  test('path-only watch uses defaults', () => {
    assert.deepEqual(m.effectiveFolder({ path: '/x' }, DEFAULTS), {
      path: '/x', branch: 'main', watchInterval: 3, pullInterval: 300, conflict: 'abort', pullAfterPush: true,
    });
  });

  test('explicit pullAfterPush false wins over defaults', () => {
    const f = m.effectiveFolder({ path: '/x', pullAfterPush: false }, DEFAULTS);
    assert.equal(f.pullAfterPush, false);
  });

  test('explicit branch and conflict win', () => {
    const f = m.effectiveFolder({ path: '/x', branch: 'dev', conflict: 'force-local' }, DEFAULTS);
    assert.equal(f.branch, 'dev');
    assert.equal(f.conflict, 'force-local');
  });

  test('explicit intervals win', () => {
    const f = m.effectiveFolder({ path: '/x', watchInterval: 7, pullInterval: 60 }, DEFAULTS);
    assert.equal(f.watchInterval, 7);
    assert.equal(f.pullInterval, 60);
  });
});

describe('loadConfig / writeConfig', () => {
  test('loadConfig on nonexistent path returns defaults', () => {
    const out = m.loadConfig(path.join(TMP, 'missing', 'config.ini'));
    assert.deepEqual(out, { defaults: DEFAULTS, watches: [] });
  });

  test('writeConfig creates parent dirs', () => {
    const p = path.join(TMP, 'a', 'b', 'config.ini');
    m.writeConfig(p, { defaults: DEFAULTS, watches: [] });
    assert.ok(fs.existsSync(p));
    assert.ok(fs.readFileSync(p, 'utf8').startsWith('; git-sync-watch config'));
  });

  test('round-trip includes explicit pullAfterPush false watch', () => {
    const model = {
      defaults: DEFAULTS,
      watches: [{ path: '/x', explicit: { pullAfterPush: true }, pullAfterPush: false }],
    };
    const p = path.join(TMP, 'rt.ini');
    m.writeConfig(p, model);
    assert.deepEqual(m.loadConfig(p), model);
  });

  test('invalid defaults value self-heals on load', () => {
    const p = path.join(TMP, 'bad.ini');
    fs.writeFileSync(p, [
      '; git-sync-watch config',
      '[defaults]',
      'watch-interval = 3',
      'pull-interval = 0',
      'conflict = abort',
      'pull-after-push = true',
      '',
    ].join('\n'));
    const out = m.loadConfig(p);
    assert.equal(out.defaults.pullInterval, 300);
    assert.equal(out.defaults.watchInterval, 3);
    // writeConfig + loadConfig output is valid input again
    m.writeConfig(p, out);
    assert.deepEqual(m.loadConfig(p), out);
  });
});

describe('buildPlistXml', () => {
  test('label', () => {
    const out = m.buildPlistXml(CFG);
    assert.ok(out.includes('<key>Label</key><string>com.git-sync-watch</string>'));
  });

  test('program arguments order', () => {
    const out = m.buildPlistXml(CFG);
    const args = ['/usr/bin/node', '/srv/git-sync-watch', 'run', '--config', '/etc/gsw.ini', '--git', '/usr/bin/git'];
    let prev = -1;
    for (const a of args) {
      const i = out.indexOf('<string>' + a + '</string>');
      assert.ok(i > prev, 'argument ' + a + ' out of order');
      prev = i;
    }
  });

  test('run-at-load and keep-alive', () => {
    const out = m.buildPlistXml(CFG);
    assert.ok(out.includes('<key>RunAtLoad</key><true/>'));
    assert.ok(out.includes('<key>KeepAlive</key><true/>'));
  });

  test('log paths under home Library/Logs', () => {
    const out = m.buildPlistXml(CFG);
    assert.ok(out.includes('<string>' + path.join(os.homedir(), 'Library', 'Logs', 'git-sync-watch.out.log') + '</string>'));
    assert.ok(out.includes('<string>' + path.join(os.homedir(), 'Library', 'Logs', 'git-sync-watch.err.log') + '</string>'));
  });

  test('ssh auth sock env', () => {
    const out = m.buildPlistXml(CFG);
    assert.ok(out.includes('<key>EnvironmentVariables</key><dict><key>SSH_AUTH_SOCK</key><string>/tmp/ssh.sock</string></dict>'));
  });

  test('no ssh auth sock when null', () => {
    const out = m.buildPlistXml(Object.assign({}, CFG, { sshSock: null }));
    assert.ok(!out.includes('SSH_AUTH_SOCK'));
  });

  test('xml escaping', () => {
    const out = m.buildPlistXml(Object.assign({}, CFG, { configPath: '/etc/a&b<c>"d' }));
    assert.ok(out.includes('/etc/a&amp;b&lt;c&gt;&quot;d'));
    assert.ok(!out.includes('/etc/a&b<c>"d'));
  });
});

describe('buildUnitText', () => {
  test('exec start line', () => {
    const out = m.buildUnitText(CFG);
    const line = out.split('\n').find(l => l.startsWith('ExecStart='));
    assert.equal(line, 'ExecStart=/usr/bin/node /srv/git-sync-watch run --config /etc/gsw.ini --git /usr/bin/git');
  });

  test('unit directives', () => {
    const out = m.buildUnitText(CFG);
    for (const d of ['After=network-online.target', 'Type=simple', 'Restart=on-failure', 'RestartSec=5', 'WantedBy=default.target']) {
      assert.ok(out.includes(d), 'missing ' + d);
    }
  });

  test('ssh sock environment', () => {
    assert.ok(m.buildUnitText(CFG).includes('Environment=SSH_AUTH_SOCK=/tmp/ssh.sock'));
    assert.ok(!m.buildUnitText(Object.assign({}, CFG, { sshSock: null })).includes('SSH_AUTH_SOCK'));
  });
});

describe('buildCronLine', () => {
  test('exact line', () => {
    assert.equal(m.buildCronLine(CFG),
      '@reboot /usr/bin/node /srv/git-sync-watch run --config /etc/gsw.ini --git /usr/bin/git >> ' +
      path.join(os.homedir(), '.local', 'state', 'git-sync-watch.log') + ' 2>&1');
  });
});
