"""Isolated desktop smoke test. Requires Python Playwright and an explicit Obsidian executable.
Never attaches to an existing profile; checks the vault identity before reading/editing UI data.
"""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--executable', required=True)
parser.add_argument('--language', choices=['en', 'zh'], help='Set only the newly created test profile language preference.')
args = parser.parse_args()

def sidebar_tabs(node):
    groups = {}
    if node.get('type') == 'tabs':
        groups[node['id']] = {leaf['id']: leaf.get('state', {}).get('type') for leaf in node.get('children', [])}
    for child in node.get('children', []):
        groups.update(sidebar_tabs(child))
    return groups

repo = Path(__file__).resolve().parents[1]
work = repo / '.test-vault'
work.mkdir(exist_ok=True)
case = Path(tempfile.mkdtemp(prefix='host-', dir=work))
vault = case / 'vault'
profile = case / 'profile'
vault.mkdir(); profile.mkdir()
config = vault / '.obsidian'
plugin_dir = config / 'plugins' / 'better-md-diff'
plugin_dir.mkdir(parents=True)
for name in ['main.js', 'manifest.json', 'styles.css']:
    shutil.copyfile(repo / 'dist' / 'better-md-diff' / name, plugin_dir / name)
(config / 'community-plugins.json').write_text('["better-md-diff"]', encoding='utf-8')
(config / 'app.json').write_text(json.dumps({'livePreview': False}), encoding='utf-8')
(profile / 'obsidian.json').write_text(json.dumps({'vaults': {'bmd-smoke': {'path': str(vault), 'ts': int(time.time() * 1000), 'open': True}}, 'autoUpdate': False}), encoding='utf-8')
before = ''.join(f'line {i}\n' for i in range(24))
current = before.replace('line 1\n', 'first change\n').replace('line 20\n', 'last change\n')
(vault / 'sample.md').write_text(before, encoding='utf-8')
items_before = '开头\n- 重置时间：04:00。\n保持文本\n## 段位变化\n\n升级时：\n保持文本2\n次数不变。\n结尾\n'
items_current = items_before.replace('04:00。', '04:00').replace('## 段位变化', '## 段位变化提示').replace('升级时：\n', '').replace('次数不变。', '次数不变（备注）。')
(vault / 'items.md').write_text(items_before, encoding='utf-8')
large = ''.join(f'{i:05d} ' + 'abcdefghij ' * 8 + '\n' for i in range(30_000))
clean_path = '版本规划/修订/2026-09-18/功能规划-修订-2026-09-18.md'
(vault / clean_path).parent.mkdir(parents=True)
(vault / clean_path).write_text('# Generated clean example\n', encoding='utf-8')
for command in [['init', '-q'], ['config', 'user.name', 'Smoke Test'], ['config', 'user.email', 'smoke@example.invalid'], ['config', 'commit.gpgsign', 'false'], ['config', 'core.autocrlf', 'false'], ['add', 'sample.md', 'items.md', clean_path], ['commit', '-qm', 'baseline']]:
    subprocess.run(['git', *command], cwd=vault, check=True, capture_output=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
log = (case / 'host.log').open('w', encoding='utf-8')
launch_args = [args.executable, f'--user-data-dir={profile}', f'--remote-debugging-port={port}', '--disable-background-networking']
process = subprocess.Popen(launch_args, stdout=log, stderr=log)
report = {'checks': [], 'vault': str(vault)}

def connect_host(pw, owned_process):
    for _ in range(60):
        if owned_process.poll() is not None:
            raise RuntimeError('Isolated Obsidian process exited; refusing to attach to another instance.')
        try:
            return pw.chromium.connect_over_cdp(f'http://127.0.0.1:{port}', timeout=1000)
        except Exception:
            time.sleep(0.5)
    raise RuntimeError('Isolated Obsidian did not expose CDP; inspect host.log')

try:
    with sync_playwright() as pw:
        browser = connect_host(pw, process)
        page = browser.contexts[0].pages[0]
        page.wait_for_function('typeof app !== "undefined" && app.vault && app.workspace?.layoutReady', timeout=60000)
        actual = page.evaluate('app.vault.adapter.getBasePath()')
        if Path(actual).resolve() != vault.resolve():
            raise RuntimeError('Vault identity mismatch; no UI data was read or edited.')
        report['checks'].append('isolated vault identity')
        if args.language and page.evaluate("localStorage.getItem('language') || 'en'") != args.language:
            page.evaluate("language => localStorage.setItem('language', language)", args.language)
            # A full, graceful restart lets the host flush its own JSON; renderer reloads race those writes.
            page.close(run_before_unload=True)
            process.wait(timeout=20)
            process = subprocess.Popen(launch_args, stdout=log, stderr=log)
            browser = connect_host(pw, process)
            page = browser.contexts[0].pages[0]
            page.wait_for_function('typeof app !== "undefined" && app.vault && app.workspace?.layoutReady', timeout=60000)
            if Path(page.evaluate('app.vault.adapter.getBasePath()')).resolve() != vault.resolve():
                raise RuntimeError('Vault identity changed after locale restart.')
        page.on('pageerror', lambda error: report.setdefault('page_errors', []).append(str(error)))
        page.on('console', lambda message: report.setdefault('console_errors', []).append(message.text) if message.type == 'error' else None)
        # Test-only inspection of this fresh profile's app preference; production uses getLanguage().
        report['language'] = page.evaluate("localStorage.getItem('language') || 'en'")
        chinese = report['language'].lower().startswith('zh')
        confirm_label = '确认还原' if chinese else 'Confirm restoration'
        # This is exclusively our freshly generated, identity-checked vault and our own build.
        # A fresh host asks for author trust asynchronously; enabling a plugin before consent races it.
        trust = page.get_by_role('button', name=re.compile('信任仓库作者并启用插件|Trust author and enable plugins', re.I))
        page.wait_for_function("app.plugins.plugins['better-md-diff']?.store || [...document.querySelectorAll('button')].some(button => /信任仓库作者并启用插件|Trust author and enable plugins/i.test(button.textContent))")
        if trust.is_visible():
            trust.click(timeout=30000)
            trust.wait_for(state='hidden')
            report['checks'].append('explicitly trusted only the generated test vault')
        else:
            report['checks'].append('host already enabled the generated vault plugin after restart')
        try:
            page.wait_for_function("app.plugins.plugins['better-md-diff']?.store")
        except Exception:
            report['plugin_diagnostic'] = page.evaluate("() => { const p = app.plugins.plugins['better-md-diff']; return {present: !!p, keys: Object.keys(p || {}), modals: [...document.querySelectorAll('.modal-container')].map(el => el.textContent), notices: [...document.querySelectorAll('.notice')].map(el => el.textContent)}; }")
            page.screenshot(path=str(case / 'startup-failure.png'))
            raise
        page.evaluate("""async () => {
          const file = app.vault.getAbstractFileByPath('sample.md');
          await app.workspace.getLeaf(false).openFile(file);
          await app.workspace.getMostRecentLeaf().setViewState({type:'markdown',state:{file:'sample.md',mode:'source',source:true}});
        }""")
        # Close the fresh-profile community settings through the host, without forced clicks.
        page.evaluate('app.setting.close()')
        page.keyboard.press('Escape')
        try:
            page.locator('.modal-container').wait_for(state='hidden')
        except Exception:
            report['startup_modals'] = page.locator('.modal-container').all_text_contents()
            page.screenshot(path=str(case / 'modal-failure.png'))
            raise
        page.evaluate("""text => {
          const view = app.workspace.getMostRecentLeaf().view;
          view.editor.setValue(text);
        }""", current)
        sidebar_before = sidebar_tabs(page.evaluate('app.workspace.getLayout().right'))
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('sample.md')")
        sidebar_after = sidebar_tabs(page.evaluate('app.workspace.getLayout().right'))
        assert len(sidebar_after) == max(1, len(sidebar_before)), 'Opening diff unexpectedly added a vertical sidebar split'
        if sidebar_before:
            assert 'better-md-diff-view' in sidebar_after[next(iter(sidebar_before))].values(), 'Diff is not in the top sidebar tab group'
        for group, leaves in sidebar_before.items():
            assert all(sidebar_after[group].get(leaf) == kind for leaf, kind in leaves.items()), 'An existing sidebar view was replaced'
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('sample.md')")
        assert page.evaluate("app.workspace.getLeavesOfType('better-md-diff-view').length") == 1
        report['checks'].append('top sidebar tab, existing views preserved, repeated opening reuses one leaf')
        page.locator('.bmd-progress').filter(has_text='第 1 / 2 处' if chinese else 'Change 1 / 2').wait_for(timeout=30000)
        command_name = page.evaluate("app.commands.commands['better-md-diff:next-change'].name")
        assert ('定位下一处差异' if chinese else 'Go to next change') in command_name
        report['checks'].append('panel and command language follow the isolated host language')
        report['checks'].append('two independent change actions in the real panel')
        page.locator('.notice.is-loading').wait_for(state='hidden', timeout=60000)
        page.locator('.bmd-next').click()
        assert page.locator('.bmd-progress').inner_text() == ('第 2 / 2 处' if chinese else 'Change 2 / 2')
        report['checks'].append('next-change navigation')
        page.locator('.bmd-previous').click()
        page.locator('.bmd-revert').first.click()
        page.get_by_role('button', name=confirm_label, exact=True).click()
        page.wait_for_function("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue().includes('line 1\\n')")
        restored = page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()")
        assert restored == before.replace('line 20\n', 'last change\n')
        report['checks'].append('single change restored; other change preserved')
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.focus()")
        page.keyboard.press('Meta+z' if os.sys.platform == 'darwin' else 'Control+z')
        page.wait_for_function("expected => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === expected", arg=current)
        report['checks'].append('native editor undo restores the complete pre-revert buffer')
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('sample.md')")
        page.locator('.bmd-revert').first.click()
        page.get_by_role('button', name='取消' if chinese else 'Cancel', exact=True).click()
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == current
        report['checks'].append('cancel leaves editor untouched')
        copied = page.evaluate("""() => {
          const code = document.querySelector('.bmd-row--added .bmd-row-text');
          const range = document.createRange(); range.selectNodeContents(code);
          const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          const clipboardData = new DataTransfer();
          document.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
          const value = clipboardData.getData('text/plain'); selection.removeAllRanges(); return value;
        }""")
        assert copied == 'first change'
        report['checks'].append('real panel copy event produces clean source')
        page.locator('.bmd-revert').first.click()
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].setViewState({type:'markdown',state:{file:'sample.md',mode:'preview'}})")
        page.get_by_role('button', name=confirm_label, exact=True).click()
        page.get_by_role('button', name=confirm_label, exact=True).wait_for(state='hidden')
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.getViewData()") == current
        report['checks'].append('mode switch rejects stale restoration')
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].setViewState({type:'markdown',state:{file:'sample.md',mode:'source',source:true}})")
        page.evaluate("""async () => {
          const file = await app.vault.create('other.md', 'temporary sample');
          const leaf = app.workspace.getLeavesOfType('markdown')[0];
          await leaf.openFile(file);
          await leaf.openFile(app.vault.getAbstractFileByPath('sample.md'));
        }""")
        page.wait_for_function("document.querySelector('.bmd-file')?.textContent === 'sample.md'")
        report['checks'].append('file switching follows the final active file')
        page.evaluate("app.vault.rename(app.vault.getAbstractFileByPath('sample.md'), 'renamed.md')")
        page.wait_for_function("app.plugins.plugins['better-md-diff'].store.get('renamed.md')?.status === 'error'")
        assert page.evaluate("app.plugins.plugins['better-md-diff'].store.get('sample.md') === undefined")
        page.evaluate("app.vault.rename(app.vault.getAbstractFileByPath('renamed.md'), 'sample.md')")
        page.wait_for_function("app.plugins.plugins['better-md-diff'].store.get('sample.md')?.status === 'ready'")
        report['checks'].append('rename forgets stale paths and recovers when tracked path returns')
        page.evaluate("app.vault.delete(app.vault.getAbstractFileByPath('other.md'))")
        assert page.evaluate("app.plugins.plugins['better-md-diff'].store.get('other.md') === undefined")
        report['checks'].append('deleted temporary file leaves no stale diff')
        definitions = page.evaluate("app.setting.pluginTabs.find(t => t.plugin?.manifest?.id === 'better-md-diff')?.getSettingDefinitions().flatMap(s => s.items).map(s => s.name)")
        assert definitions and len(definitions) == 13
        report['checks'].append('13 searchable settings registered in real host')
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath('items.md'))")
        page.evaluate("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.setValue(text)", items_current)
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('items.md')")
        page.wait_for_function("document.querySelectorAll('.bmd-change').length === 4")
        assert page.locator('.bmd-diff-region').count() == 1
        assert page.locator('.bmd-hunk').count() == 0
        deletion_marker = page.locator('.bmd-gutter-marker--deleted').first
        deletion_marker.wait_for()
        assert deletion_marker.inner_text() == '−1'
        marker_rgb = deletion_marker.evaluate("el => { const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); ctx.fillStyle = getComputedStyle(el).color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); }")
        assert marker_rgb[0] > marker_rgb[1] and marker_rgb[0] > marker_rgb[2], 'Deletion marker should use the red theme token'
        report['deletion_marker_rgb'] = marker_rgb
        assert page.locator('.cm-line.bmd-line--deleted').count() == 0
        anchor = page.locator('.cm-line.bmd-deletion-anchor').first
        assert 'inset' in anchor.evaluate('el => getComputedStyle(el).boxShadow')
        assert deletion_marker.evaluate('el => getComputedStyle(el).backgroundColor') != 'rgba(0, 0, 0, 0)'
        assert page.locator('.bmd-change-actions').count() == 0
        rows = page.locator('.bmd-change').nth(1).locator('.bmd-row').all()
        row_boxes = [row.bounding_box() for row in rows]
        assert abs(row_boxes[0]['y'] + row_boxes[0]['height'] - row_boxes[1]['y']) < 1, 'Old/new rows should be adjacent'
        context = page.locator('.bmd-row--context .bmd-row-text').first
        normal = page.locator('.bmd-row--added .bmd-row-text').first
        assert context.evaluate('el => getComputedStyle(el).color') == normal.evaluate('el => getComputedStyle(el).color')
        deletion_marker.click()
        page.wait_for_function("document.querySelector('.bmd-row--deleted.bmd-row--current .bmd-row-text')?.textContent === '升级时：'")
        report['checks'].append('visible deletion rule and count open the old row without source mutation; adjacent old/new rows keep normal text contrast')
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == items_current
        page.locator('.bmd-revert').nth(1).click()
        assert 'HEAD' in page.locator('.bmd-revert-previews').inner_text()
        page.get_by_role('button', name=confirm_label, exact=True).click()
        page.get_by_role('button', name=confirm_label, exact=True).wait_for(state='hidden')
        actual_item_text = page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()")
        if actual_item_text != items_current.replace('## 段位变化提示', '## 段位变化'):
            report['item_restore_diagnostic'] = {'actual': actual_item_text, 'notices': page.locator('.notice').all_text_contents(), 'mode': page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.getMode()")}
            page.screenshot(path=str(case / 'item-failure.png'))
            raise AssertionError('Selected item did not restore independently')
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.focus()")
        page.keyboard.press('Meta+z' if os.sys.platform == 'darwin' else 'Control+z')
        page.wait_for_function("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === text", arg=items_current)
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('items.md')")
        page.wait_for_function("document.querySelectorAll('.bmd-change').length === 4")
        page.locator('.bmd-revert').nth(2).click()
        page.get_by_role('button', name=confirm_label, exact=True).click()
        page.wait_for_function("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === text", arg=items_current.replace('保持文本2', '升级时：\n保持文本2'))
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.focus()")
        page.keyboard.press('Meta+z' if os.sys.platform == 'darwin' else 'Control+z')
        page.wait_for_function("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === text", arg=items_current)
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('items.md')")
        page.wait_for_function("document.querySelectorAll('.bmd-change').length === 4")
        page.wait_for_function("document.querySelectorAll('.notice').length === 0", timeout=20000)
        page.locator('.bmd-gutter-marker--deleted').first.click()
        page.wait_for_function("document.querySelector('.bmd-row--deleted.bmd-row--current .bmd-row-text')?.textContent === '升级时：'")
        page.locator('.bmd-panel').screenshot(path=str(case / 'independent-changes.png'))
        page.screenshot(path=str(case / 'deletion-gutter.png'))
        report['checks'].append('four nearby edits share context but restore individually, including pure deletion and native undo')
        report['change_layouts'] = []
        for theme in ['light', 'dark']:
            page.evaluate("theme => { document.body.classList.toggle('theme-dark', theme === 'dark'); document.body.classList.toggle('theme-light', theme === 'light'); }", theme)
            for width in [280, 440]:
                page.locator('.workspace-split.mod-right-split').evaluate("(el, width) => { el.style.width = `${width}px`; el.style.flexBasis = `${width}px`; el.style.flexGrow = '0'; }", width)
                page.wait_for_function("width => Math.abs(document.querySelector('.bmd-panel').getBoundingClientRect().width - width) < 4", arg=width)
                dimensions = page.locator('.bmd-diff-body').evaluate("el => ({width: el.clientWidth, content: el.scrollWidth, controlsClear: [...el.querySelectorAll('.bmd-change')].every(item => item.querySelector('.bmd-row-text').getBoundingClientRect().right <= item.querySelector('.bmd-revert').getBoundingClientRect().left)})")
                assert dimensions['content'] <= dimensions['width'] and dimensions['controlsClear'], 'Inline restore controls must not cover source text or overflow'
                report['change_layouts'].append({'theme': theme, **dimensions})
                page.locator('.bmd-panel').screenshot(path=str(case / f'panel-changes-{theme}-{width}.png'))
        report['checks'].append('light/dark changes at 280/440px: restore controls do not cover text or cause horizontal overflow')
        page.evaluate("document.body.classList.remove('theme-dark'); document.body.classList.add('theme-light')")
        # Add the large fixture after startup indexing; do not race the fresh-host indexer.
        (vault / 'large.md').write_text(large, encoding='utf-8')
        for command in [['add', 'large.md'], ['commit', '-qm', 'large fixture']]:
            subprocess.run(['git', *command], cwd=vault, check=True, capture_output=True)
        page.wait_for_function("app.vault.getAbstractFileByPath('large.md')")
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath('large.md'))")
        page.wait_for_function("app.plugins.plugins['better-md-diff'].store.get('large.md')?.status === 'error'")
        page.evaluate("async () => { const p = app.plugins.plugins['better-md-diff']; p.settings.maxFileMiB = 10; p.settings.maxLines = 100000; await p.applySettings(); }")
        page.wait_for_function("app.plugins.plugins['better-md-diff'].store.get('large.md')?.status === 'ready'")
        report['checks'].append('raising limits recovers an open 2.8 MB / 30001-line note')
        large_current = '# changed\n' + large
        page.evaluate("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.setValue(text)", large_current)
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('large.md')")
        page.locator('.bmd-revert').first.click()
        page.get_by_role('button', name=confirm_label, exact=True).click()
        page.wait_for_function("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === text", arg=large)
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.focus()")
        page.keyboard.press('Meta+z' if os.sys.platform == 'darwin' else 'Control+z')
        page.wait_for_function("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === text", arg=large_current)
        report['checks'].append('large-note restoration uses fresh Git limits and supports native undo')
        page.evaluate("async () => { await app.plugins.disablePlugin('better-md-diff'); await app.plugins.enablePlugin('better-md-diff'); }")
        assert page.evaluate("app.plugins.plugins['better-md-diff'].settings.maxFileMiB === 10 && app.plugins.plugins['better-md-diff'].settings.maxLines === 100000")
        report['checks'].append('document limits survive plugin reload')
        page.evaluate("async () => { const p = app.plugins.plugins['better-md-diff']; p.settings.maxFileMiB = 2; p.settings.maxLines = 20000; await p.applySettings(); }")
        page.wait_for_function("app.plugins.plugins['better-md-diff'].store.get('large.md')?.status === 'error'")
        report['checks'].append('lowering limits invalidates previously accepted content')
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath('sample.md'))")
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('sample.md')")
        page.locator('.bmd-revert').first.wait_for()
        page.screenshot(path=str(case / 'host.png'))
        page.evaluate("path => app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath(path))", clean_path)
        page.evaluate("path => app.plugins.plugins['better-md-diff'].openDiff(path)", clean_path)
        page.locator('.bmd-empty-title').wait_for()
        assert page.locator('.bmd-file').inner_text() == clean_path.split('/')[-1]
        assert page.locator('.bmd-stats').count() == 0
        report['layouts'] = []
        for theme in ['light', 'dark']:
            page.evaluate("theme => { document.body.classList.toggle('theme-dark', theme === 'dark'); document.body.classList.toggle('theme-light', theme === 'light'); }", theme)
            for width in [280, 440]:
                page.locator('.workspace-split.mod-right-split').evaluate("(el, width) => { el.style.width = `${width}px`; el.style.flexBasis = `${width}px`; el.style.flexGrow = '0'; }", width)
                page.wait_for_function("width => Math.abs(document.querySelector('.bmd-panel').getBoundingClientRect().width - width) < 4", arg=width)
                dimensions = page.locator('.bmd-panel').evaluate("el => ({width: el.clientWidth, content: el.scrollWidth, summary: el.querySelector('.bmd-summary').scrollWidth, summaryWidth: el.querySelector('.bmd-summary').clientWidth})")
                assert dimensions['content'] <= dimensions['width'] and dimensions['summary'] <= dimensions['summaryWidth']
                report['layouts'].append({'theme': theme, **dimensions})
                page.locator('.bmd-panel').screenshot(path=str(case / f'panel-clean-{theme}-{width}.png'))
        report['checks'].append('clean-state hierarchy and 280/440px layouts in light/dark themes')
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath('sample.md'))")
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('sample.md')")
        page.locator('.bmd-revert').first.wait_for()
        # Before unloading, open confirmation to exercise abort/cleanup in the actual host.
        page.locator('.bmd-revert').first.click()
        page.evaluate("app.plugins.disablePlugin('better-md-diff')")
        assert page.get_by_role('button', name=confirm_label, exact=True).count() == 0
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == current
        report['checks'].append('unload closes confirmation without writing')
        report['status'] = 'passed'
except Exception as error:
    report['status'] = 'failed'; report['error'] = str(error)
    try:
        report['visible_modals'] = page.locator('.modal-container').all_text_contents()
        page.screenshot(path=str(case / 'failure.png'), timeout=5000)
    except Exception:
        pass  # The host may already have exited; preserve the original failure.
    raise
finally:
    (case / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f'Evidence: {case}')
    if process.poll() is None:
        if os.name == 'nt': subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
        else: process.terminate(); process.wait(timeout=10)
    log.close()
