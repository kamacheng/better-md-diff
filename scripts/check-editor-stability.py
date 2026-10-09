"""Measure source-editor layout during diff refresh in an owned Live Preview vault.
Requires Python Playwright and an explicit desktop Obsidian executable. Never attaches to a user profile.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

parser = argparse.ArgumentParser()
parser.add_argument('--executable', required=True)
parser.add_argument('--condition', choices=['plugin', 'no-markers', 'no-follow', 'disabled'], default='plugin')
parser.add_argument('--long-document', action='store_true')
parser.add_argument('--deletion-count', type=int, choices=[1, 1000], default=1)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
work = repo / '.test-vault'
work.mkdir(exist_ok=True)
case = Path(tempfile.mkdtemp(prefix='stability-', dir=work))
vault = case / 'vault'; vault.mkdir()
profile = case / 'profile'; profile.mkdir()
config = vault / '.obsidian'
plugin_dir = config / 'plugins' / 'better-md-diff'
plugin_dir.mkdir(parents=True)
for name in ['main.js', 'manifest.json', 'styles.css']:
    shutil.copyfile(repo / 'dist' / 'better-md-diff' / name, plugin_dir / name)
(config / 'community-plugins.json').write_text('["better-md-diff"]', encoding='utf-8')
(config / 'app.json').write_text(json.dumps({'livePreview': True, 'readableLineLength': False}), encoding='utf-8')
(profile / 'obsidian.json').write_text(json.dumps({'vaults': {'stability': {'path': str(vault), 'ts': int(time.time() * 1000), 'open': True}}, 'autoUpdate': False}), encoding='utf-8')
lines = ['Keep before.', 'This line is removed before editing.', 'EDITING ANCHOR stays short.', 'Keep after.']
if args.long_document:
    lines = ['# Generated layout fixture', '']
    for i in range(65):
        if i % 9 == 0:
            lines.extend([f'## Section {i}', ''])
        lines.extend([f'Paragraph {i}: ' + ('用于检查长段落换行稳定性的文字。' * (9 + i % 8)), ''])
        if i == 35:
            lines.extend(['This line is removed before editing.', '', 'EDITING ANCHOR stays short.', ''])
removed = ''.join(f'Deleted line {i}\n' for i in range(args.deletion_count))
before = ('\n'.join(lines) + '\n').replace('This line is removed before editing.\n', removed)
current = before.replace(removed, '')
(vault / 'layout.md').write_text(before, encoding='utf-8', newline='\n')
for command in [['init', '-q'], ['config', 'user.name', 'Layout Test'], ['config', 'user.email', 'layout@example.invalid'], ['config', 'commit.gpgsign', 'false'], ['config', 'core.autocrlf', 'false'], ['add', 'layout.md'], ['commit', '-qm', 'generated baseline']]:
    subprocess.run(['git', *command], cwd=vault, check=True, capture_output=True)
(vault / 'layout.md').write_text(current, encoding='utf-8', newline='\n')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
log = (case / 'host.log').open('w', encoding='utf-8')
process = subprocess.Popen([args.executable, f'--user-data-dir={profile}', f'--remote-debugging-port={port}', '--disable-background-networking'], stdout=log, stderr=log)
report = {'condition': args.condition, 'long_document': args.long_document, 'deletion_count': args.deletion_count, 'vault': str(vault), 'checks': [], 'frames': {}, 'spreads': {}}
try:
    with sync_playwright() as pw:
        browser = None
        for _ in range(60):
            if process.poll() is not None:
                raise RuntimeError('Owned Obsidian process exited; refusing to attach elsewhere.')
            try:
                browser = pw.chromium.connect_over_cdp(f'http://127.0.0.1:{port}', timeout=1000)
                break
            except Exception:
                time.sleep(0.5)
        if browser is None:
            raise RuntimeError('Owned host did not expose CDP.')
        context = browser.contexts[0]; page = context.pages[0]
        page.wait_for_function('typeof app !== "undefined" && app.workspace?.layoutReady', timeout=60000)
        if Path(page.evaluate('app.vault.adapter.getBasePath()')).resolve() != vault.resolve():
            raise RuntimeError('Vault identity mismatch; no note content was accessed.')
        report['checks'].append('isolated vault identity')
        context.route(re.compile(r'^https?://'), lambda route: route.abort())
        trust = page.get_by_role('button', name=re.compile('信任仓库作者并启用插件|Trust author and enable plugins', re.I))
        page.wait_for_function("app.plugins.plugins['better-md-diff']?.store || [...document.querySelectorAll('button')].some(b => /信任仓库作者并启用插件|Trust author and enable plugins/i.test(b.textContent))")
        if trust.is_visible():
            trust.click(); trust.wait_for(state='hidden')
            page.locator('.modal-container').wait_for(state='visible')
        page.wait_for_function("app.plugins.plugins['better-md-diff']?.store")
        page.evaluate('app.setting.close()'); page.keyboard.press('Escape')
        page.locator('.modal-container').wait_for(state='hidden')
        page.set_viewport_size({'width': 1160, 'height': 850})
        page.on('pageerror', lambda error: report.setdefault('page_errors', []).append(str(error)))
        page.evaluate("""async () => {
          const leaf = app.workspace.getLeaf(false);
          await leaf.openFile(app.vault.getAbstractFileByPath('layout.md'));
          await leaf.setViewState({type:'markdown', state:{file:'layout.md', mode:'source', source:false}});
          app.workspace.leftSplit.collapse();
          await app.plugins.plugins['better-md-diff'].openDiff('layout.md');
        }""")
        page.wait_for_function("app.plugins.plugins['better-md-diff'].store.get('layout.md')?.status === 'ready'")
        if args.condition == 'no-markers':
            page.evaluate("async () => { const p = app.plugins.plugins['better-md-diff']; p.settings.showMarkers = false; await p.applySettings(); }")
        elif args.condition == 'no-follow':
            page.evaluate("async () => { const p = app.plugins.plugins['better-md-diff']; p.settings.followEditor = false; p.settings.followNavigation = false; await p.applySettings(); }")
        elif args.condition == 'disabled':
            page.evaluate("app.plugins.disablePlugin('better-md-diff')")
        page.evaluate(r"""() => {
          const view = app.workspace.getLeavesOfType('markdown')[0].view;
          const editor = view.editor;
          const line = editor.getValue().split('\n').findIndex(text => text.startsWith('EDITING ANCHOR'));
          editor.setCursor({line, ch: 4}); editor.focus();
          editor.scrollIntoView({from:{line, ch:0}, to:{line, ch:0}}, true);
        }""")
        page.wait_for_timeout(1200)
        report['setup'] = page.evaluate("""() => {
          const view = app.workspace.getLeavesOfType('markdown')[0].view;
          const badge = view.containerEl.querySelector('.bmd-gutter-marker--deleted');
          return {mode:view.getMode(), livePreview:!!view.containerEl.querySelector('.is-live-preview'), deletionMarkers:document.querySelectorAll('.bmd-gutter-marker--deleted').length,
            badge:badge && {text:badge.textContent, label:badge.getAttribute('aria-label'), title:badge.title, width:badge.getBoundingClientRect().width}};
        }""")
        assert report['setup']['livePreview'], 'The fixture must exercise actual Live Preview'
        if args.condition in ['plugin', 'no-follow']:
            assert report['setup']['deletionMarkers'] > 0, 'Deletion marker must be visible before typing'
            badge = report['setup']['badge']
            assert badge['text'] == f'−{args.deletion_count}'
            assert badge['width'] <= 28, 'Count badge must not overflow the reserved gutter'
            assert str(args.deletion_count) in badge['label'] and badge['title'] == badge['label']
        page.screenshot(path=str(case / 'before.png'))
        page.evaluate("""() => {
          const view = app.workspace.getLeavesOfType('markdown')[0].view;
          const cm = view.editor.cm;
          window.sampleLayout = () => {
            const position = cm.coordsAtPos(cm.state.selection.main.head);
            const content = cm.contentDOM.getBoundingClientRect();
            const gutter = cm.dom.querySelector('.bmd-gutter');
            return {time:performance.now(), cursorTop:position?.top, scrollTop:cm.scrollDOM.scrollTop,
              contentLeft:content.left, contentWidth:content.width, gutterWidth:gutter?.getBoundingClientRect().width ?? 0};
          };
        }""")

        def measure(name, action, check_cursor=True):
            page.evaluate("""() => {
              window.layoutFrames = [window.sampleLayout()]; window.captureLayout = true;
              const capture = () => { if (!window.captureLayout) return; window.layoutFrames.push(window.sampleLayout()); window.layoutFrameRequest = requestAnimationFrame(capture); };
              window.layoutFrameRequest = requestAnimationFrame(capture);
            }""")
            action()
            if args.condition != 'disabled':
                page.wait_for_function("() => { const state = app.plugins.plugins['better-md-diff'].store.get('layout.md'); return state?.status === 'ready' && state.current === app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue(); }")
            page.wait_for_timeout(1100)
            frames = page.evaluate('() => { window.captureLayout = false; cancelAnimationFrame(window.layoutFrameRequest); return window.layoutFrames; }')
            report['frames'][name] = frames
            spread = {key: max(frame[key] for frame in frames if frame[key] is not None) - min(frame[key] for frame in frames if frame[key] is not None)
                      for key in ['cursorTop', 'scrollTop', 'contentLeft', 'contentWidth', 'gutterWidth']}
            report['spreads'][name] = spread
            if name == 'typing': report['spread'] = spread
            if check_cursor:
                assert spread['cursorTop'] <= 1, f"{name}: source cursor row moved by {spread['cursorTop']:.2f}px"
            assert spread['contentWidth'] <= 1, f"{name}: source content width changed by {spread['contentWidth']:.2f}px"
            assert spread['contentLeft'] <= 1, f"{name}: source content left edge moved by {spread['contentLeft']:.2f}px"
            report['checks'].append(f'{name}: stable source layout')

        measure('typing', lambda: page.keyboard.type('x'))
        latest = page.evaluate("async () => { const view = app.workspace.getLeavesOfType('markdown')[0].view; await view.save(); return view.editor.getValue(); }")
        assert latest == current.replace('EDITING ANCHOR', 'EDITxING ANCHOR'), 'Only the intended character should be inserted'
        page.wait_for_function("async expected => await app.vault.adapter.read('layout.md') === expected", arg=latest)
        external = latest.replace('Keep before.', 'Keep before!').replace('# Generated layout fixture', '# Generated layout fixturE')
        assert external != latest

        def external_write():
            (vault / 'layout.md').write_text(external, encoding='utf-8', newline='\n')
            page.wait_for_function("expected => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === expected", arg=external)

        measure('external-write', external_write)
        measure('cursor-navigation', lambda: page.evaluate("""() => {
          const editor = app.workspace.getLeavesOfType('markdown')[0].view.editor;
          editor.setCursor({line:0, ch:0}); editor.scrollIntoView({from:{line:0, ch:0}, to:{line:0, ch:0}}, true);
        }"""), check_cursor=False)
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == external
        page.screenshot(path=str(case / 'after.png'))
        assert not report.get('page_errors'), 'Unexpected renderer errors'
        report['status'] = 'passed'
except Exception as error:
    report.update({'status': 'failed', 'error': str(error)})
    raise
finally:
    try:
        (case / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    finally:
        if process.poll() is None:
            if os.name == 'nt': subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
            else: process.terminate(); process.wait(timeout=10)
        log.close()
    print(json.dumps({key: value for key, value in report.items() if key != 'frames'}, ensure_ascii=False, indent=2))
    print(f'Evidence: {case}')
