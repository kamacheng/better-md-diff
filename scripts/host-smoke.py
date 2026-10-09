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
nav_before = ''.join(f'Navigation line {i}.\n\n' for i in range(240))
nav_current = nav_before
for i in [0, 40, 42, 120, 160, 239]:
    nav_current = nav_current.replace(f'Navigation line {i}.', f'Changed navigation line {i}.')
nav_current = nav_current.replace('Navigation line 80.\n', '')
(vault / 'navigation.md').write_text(nav_before, encoding='utf-8')
spaces_before = ''.join(f'| 功能 {i} | 处理结果 |\n' for i in range(6)) + '\nUnchanged tail.\n\n'
spaces_current = spaces_before.replace('结果 |', '结果' + ' ' * 60 + '|') + '制表符\t结尾\n'
(vault / 'spaces.md').write_text(spaces_before, encoding='utf-8')
flags_before = '# Generated source flags\n\nKeep before additions.\nKeep before modifications.\nOld line one.\nOld line two.\nKeep before deletion.\n\n---\n\nDeleted line one.\nDeleted line two.\n## Native heading\nKeep after.\n'
flags_current = flags_before.replace('Keep before additions.\n', 'Keep before additions.\nAdded one.\nAdded two.\nAdded three: ' + 'wrapped text ' * 12 + '\n').replace('Old line one.\nOld line two.', 'Modified one.\nModified two: ' + 'wrapped text ' * 12).replace('Deleted line one.\nDeleted line two.\n', '')
(vault / 'flags.md').write_text(flags_before, encoding='utf-8')
blocks_before = '# Generated blocks\n\n| A | B |\n| --- | --- |\n| old | keep |\n\n## Folded changes\n\nFirst old.\n\nKeep section context.\n\nSecond old.\n'
blocks_current = blocks_before.replace('| old |', '| new |').replace('First old.', 'First new.').replace('Second old.', 'Second new.')
(vault / 'blocks.md').write_text(blocks_before, encoding='utf-8')
alignment = json.loads((repo / 'tests' / 'fixtures' / 'blank-alignment.json').read_text(encoding='utf-8'))
alignment_before = '\n'.join(alignment['before'])
alignment_current = '\n'.join(alignment['after'])
(vault / 'alignment.md').write_text(alignment_before, encoding='utf-8')
large = ''.join(f'{i:05d} ' + 'abcdefghij ' * 8 + '\n' for i in range(30_000))
clean_path = '版本规划/修订/2026-09-18/功能规划-修订-2026-09-18.md'
(vault / clean_path).parent.mkdir(parents=True)
(vault / clean_path).write_text('# Generated clean example\n', encoding='utf-8')
for command in [['init', '-q'], ['config', 'user.name', 'Smoke Test'], ['config', 'user.email', 'smoke@example.invalid'], ['config', 'commit.gpgsign', 'false'], ['config', 'core.autocrlf', 'false'], ['add', 'sample.md', 'items.md', 'navigation.md', 'spaces.md', 'flags.md', 'blocks.md', 'alignment.md', clean_path], ['commit', '-qm', 'baseline']]:
    subprocess.run(['git', *command], cwd=vault, check=True, capture_output=True)
(vault / 'navigation.md').write_text(nav_current, encoding='utf-8')
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
        progress_prefix = '改动' if chinese else 'Change'
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
        page.locator('.bmd-progress').filter(has_text=f'{progress_prefix} 1 / 2').wait_for(timeout=30000)
        assert page.locator('.bmd-progress').inner_text() == f'{progress_prefix} 1 / 2'
        assert page.locator('.bmd-progress').get_attribute('aria-label') == f'{progress_prefix} 1 / 2'
        command_name = page.evaluate("app.commands.commands['better-md-diff:next-change'].name")
        assert ('定位下一处差异' if chinese else 'Go to next change') in command_name
        report['checks'].append('panel and command language follow the isolated host language')
        report['checks'].append('two independent change actions in the real panel')
        assert page.locator('.bmd-region-heading').count() == 2
        assert page.locator('.bmd-region-heading').first.inner_text() == ('当前 1–5 行 · 1 处改动' if chinese else 'Current lines 1–5 · 1 change')
        assert page.locator('.bmd-region-heading button').count() == 2
        page.locator('.notice.is-loading').wait_for(state='hidden', timeout=60000)
        assert page.locator('.workspace-tab-header .lucide-file-diff').count() == 1
        assert page.locator('.side-dock-ribbon-action .lucide-file-diff').count() == 1
        page.locator('.nav-file-title[data-path="sample.md"]').click(button='right')
        assert page.locator('.menu-item .lucide-file-diff').count() == 1
        page.screenshot(path=str(case / 'diff-icon.png'))
        page.keyboard.press('Escape')
        report['checks'].append('file-diff SVG renders in the tab, ribbon and file context menu')
        # Follow visual order with the keyboard; icon-only controls retain localized names.
        page.locator('.bmd-refresh').focus()
        for selector in ['.bmd-previous', '.bmd-next', '.bmd-help-button']:
            page.keyboard.press('Tab')
            assert page.locator(selector).evaluate("el => document.activeElement === el && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none'")
            assert page.locator(selector).get_attribute('aria-label')
        assert page.locator('.bmd-summary details').count() == 0
        body_box = page.locator('.bmd-diff-body').bounding_box()
        page.keyboard.press('Enter')
        page.locator('.bmd-reading-guide').wait_for()
        assert page.locator('.bmd-panel .bmd-reading-guide').count() == 0
        assert page.locator('.bmd-guide-title').inner_text() == ('阅读说明' if chinese else 'Reading guide')
        for _ in range(3):
            page.keyboard.press('Tab')
            assert page.locator('.modal-container').evaluate('el => el.contains(document.activeElement)')
        page.keyboard.press('Escape')
        page.locator('.bmd-reading-guide').wait_for(state='hidden')
        assert page.locator('.bmd-help-button').evaluate('el => document.activeElement === el')
        page.keyboard.press('Enter')
        page.locator('.bmd-guide-close').focus()
        page.keyboard.press('Enter')
        page.locator('.bmd-reading-guide').wait_for(state='hidden')
        assert page.locator('.bmd-help-button').evaluate('el => document.activeElement === el')
        assert page.locator('.bmd-diff-body').bounding_box() == body_box
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == current
        report['checks'].append('keyboard order, visible focus, localized guide, native focus trap, Escape/close return focus; no sidebar reflow or source edits')
        page.locator('.bmd-next').click()
        assert page.locator('.bmd-progress').inner_text() == f'{progress_prefix} 2 / 2'
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
        # Three operations can share two reading groups; their labels and action scopes differ.
        nearby = current.replace('line 3\n', 'nearby change\n')
        page.evaluate("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.setValue(text)", nearby)
        page.wait_for_function("text => document.querySelector('.bmd-progress').textContent === text", arg=f'{progress_prefix} 1 / 3')
        assert page.locator('.bmd-region-heading').all_text_contents() == (
            ['当前 1–7 行 · 2 处改动', '当前 18–24 行 · 1 处改动'] if chinese
            else ['Current lines 1–7 · 2 changes', 'Current lines 18–24 · 1 change'])
        page.wait_for_function("document.querySelectorAll('.notice').length === 0", timeout=20000)
        page.locator('.bmd-panel').screenshot(path=str(case / 'change-counts.png'))
        page.locator('.bmd-next').click()
        assert page.locator('.bmd-progress').inner_text() == f'{progress_prefix} 2 / 3'
        assert page.locator('.bmd-diff-region--selected .bmd-region-heading').inner_text().endswith('2 处改动' if chinese else '2 changes')
        page.locator('.bmd-next').click()
        assert page.locator('.bmd-progress').inner_text() == f'{progress_prefix} 3 / 3'
        assert page.locator('.bmd-diff-region--selected .bmd-region-heading').inner_text().endswith('1 处改动' if chinese else '1 change')
        page.locator('.bmd-revert').nth(1).click()
        page.get_by_role('button', name=confirm_label, exact=True).click()
        page.wait_for_function("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === text", arg=current)
        page.wait_for_function("document.querySelectorAll('.bmd-change').length === 2")
        assert all(title.endswith('1 处改动' if chinese else '1 change') for title in page.locator('.bmd-region-heading').all_text_contents())
        report['checks'].append('explicit global change progress and per-group counts distinguish three actions from two reading groups; next visits each item and restoration only removes the selected nearby change')
        # A long fixture includes nearby edits, a pure deletion, and natural document boundaries.
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath('navigation.md'))")
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('navigation.md')")
        page.wait_for_function("document.querySelectorAll('.bmd-change').length === 7")
        assert page.locator('.bmd-region-heading').count() == 6, 'Nearby edits share a display block, not an action'
        block_geometry = page.locator('.bmd-diff-body').evaluate("""body => [...body.querySelectorAll('.bmd-diff-region')].map((el, index, blocks) => {
          const style = getComputedStyle(el), box = el.getBoundingClientRect();
          return {borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
            gap: index ? box.top - blocks[index - 1].getBoundingClientRect().bottom : null,
            headerBorder: getComputedStyle(el.querySelector('.bmd-region-heading')).borderBottomWidth};
        })""")
        assert all(block['borders'] == ['1px'] * 4 and block['headerBorder'] == '1px' and (block['gap'] is None or block['gap'] >= 19) for block in block_geometry), block_geometry
        report['checks'].append('display blocks have full borders, distinct heading bars and 20px separation; seven actions remain independent across six blocks')
        page.evaluate(r"""() => {
          window.bmdNavigationMetrics = () => {
            const view = app.workspace.getLeavesOfType('markdown')[0].view;
            const body = document.querySelector('.bmd-diff-body');
            const items = [...body.querySelectorAll('.bmd-change')];
            const selected = body.querySelector('.bmd-change--selected'), index = items.indexOf(selected);
            const diff = app.plugins.plugins['better-md-diff'].store.get('navigation.md').diff;
            const line = Math.min(diff.changes[index].from, diff.lineCount - 1);
            const error = (scroller, rect, tall = false) => {
              if (!rect) return 99999;
              const top = scroller.getBoundingClientRect().top + scroller.clientTop;
              const offset = tall && rect.height > scroller.clientHeight - 16
                ? rect.top - top - 8 : (rect.top + rect.bottom) / 2 - top - scroller.clientHeight / 2;
              if (scroller.scrollTop <= 1 && offset < 0) return 0;
              if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1 && offset > 0) return 0;
              return Math.abs(offset);
            };
            let sourceError, sourceTop;
            if (view.getMode() === 'source') {
              const cm = view.editor.cm;
              sourceError = error(cm.scrollDOM, cm.coordsAtPos(cm.state.doc.line(line + 1).from));
              sourceTop = cm.scrollDOM.scrollTop;
            } else {
              const text = view.getViewData().split('\n').slice(line).find(text => text.trim());
              const container = view.containerEl.querySelector('.markdown-preview-view');
              const paragraph = [...container.querySelectorAll('p')].find(el => el.textContent === text);
              sourceError = error(container, paragraph?.getBoundingClientRect());
              sourceTop = container.scrollTop;
            }
            return {index, line, sourceError, sourceTop, diffError: error(body, selected.getBoundingClientRect(), true),
              diffTop: body.scrollTop, mode: view.getMode(), focus: document.activeElement?.className,
              currentBlocks: body.querySelectorAll('.bmd-diff-region--selected').length};
          };
        }""")
        report['navigation'] = []
        for mode, source in [('source', True), ('source', False), ('preview', False)]:
            page.evaluate("state => app.workspace.getLeavesOfType('markdown')[0].setViewState({type:'markdown',state:{file:'navigation.md',...state}})", {'mode': mode, 'source': source})
            if mode == 'preview':
                # setViewState resolves before the host computes/restores its reading layout.
                # Test-only readiness inspection: production uses only the public navigation API.
                page.wait_for_function("() => { const r = app.workspace.getLeavesOfType('markdown')[0].view.previewMode.renderer; return r.text === r.lastText && r.sections.length && r.sections.every(section => section.computed); }")
            page.evaluate("app.workspace.getLeavesOfType('better-md-diff-view')[0].view.showLine(0)")
            if mode == 'source':
                assert page.locator('.markdown-source-view.is-live-preview').count() == (0 if source else 1)
            page.wait_for_function("text => document.querySelector('.bmd-progress').textContent === text", arg=f'{progress_prefix} 1 / 7')
            for selector, index in [('.bmd-next', 1), ('.bmd-next', 2), ('.bmd-next', 3), ('.bmd-previous', 2), ('.bmd-previous', 1), ('.bmd-previous', 0), ('.bmd-previous', 6)]:
                page.locator(selector).click()
                # Rendered Markdown may center the source boundary rather than the paragraph's midpoint.
                tolerance = 48 if mode == 'preview' else 2
                try:
                    page.wait_for_function("args => { const m = window.bmdNavigationMetrics(); return m.index === args.index && m.diffError <= 2 && m.sourceError <= args.tolerance; }", arg={'index': index, 'tolerance': tolerance}, timeout=10000)
                except Exception:
                    report['navigation_failure'] = page.evaluate('window.bmdNavigationMetrics()')
                    page.screenshot(path=str(case / 'navigation-failure.png'))
                    raise
                metrics = page.evaluate('window.bmdNavigationMetrics()')
                assert metrics['mode'] == mode and metrics['currentBlocks'] == 1, metrics
                assert selector[1:] in metrics['focus'], metrics
                report['navigation'].append({'sourceMode': source, **metrics})
                if index == 2:
                    page.locator('.bmd-panel').screenshot(path=str(case / f'block-center-{mode}-{source}.png'))
            page.screenshot(path=str(case / f'navigation-{mode}-{source}.png'))
            # Disabling navigation linkage leaves the source position and mode unchanged.
            page.evaluate("app.plugins.plugins['better-md-diff'].settings.followNavigation = false")
            before_top = page.evaluate('window.bmdNavigationMetrics().sourceTop')
            page.locator('.bmd-previous').click()
            page.wait_for_function("window.bmdNavigationMetrics().index === 5 && window.bmdNavigationMetrics().diffError <= 2")
            assert abs(page.evaluate('window.bmdNavigationMetrics().sourceTop') - before_top) <= 1
            assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.getMode()") == mode
            page.evaluate("app.plugins.plugins['better-md-diff'].settings.followNavigation = true")
            for selector, number, index, key in [('.bmd-region-jump', 1, 1, None), ('.bmd-change-title', 2, 2, None), ('.bmd-region-jump', 1, 1, 'Enter'), ('.bmd-change-title', 3, 3, None)]:
                control = page.locator(selector).nth(number)
                if key:
                    control.focus()
                    page.keyboard.press('Tab')
                    page.keyboard.press('Shift+Tab')
                    assert control.evaluate("el => document.activeElement === el && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none'")
                    page.keyboard.press(key)
                else:
                    control.click()
                page.wait_for_function("args => { const m = window.bmdNavigationMetrics(); return m.index === args.index && m.diffError <= 2 && m.sourceError <= args.tolerance; }", arg={'index': index, 'tolerance': tolerance})
                assert control.evaluate('el => document.activeElement === el')
                assert page.locator('.bmd-region-jump[aria-current="location"]').count() == 1
            # Actual body selection must not activate another change or move the source.
            source_top = page.evaluate('window.bmdNavigationMetrics().sourceTop')
            page.locator('.bmd-change').nth(2).locator('.bmd-row-text').first.dblclick()
            assert page.evaluate('!!document.getSelection()?.toString()')
            assert page.evaluate('window.bmdNavigationMetrics().index') == 3
            assert abs(page.evaluate('window.bmdNavigationMetrics().sourceTop') - source_top) <= 1
            page.evaluate('document.getSelection().removeAllRanges()')
            page.evaluate("app.plugins.plugins['better-md-diff'].settings.followNavigation = false")
            page.locator('.bmd-region-jump').first.click()
            page.wait_for_function('window.bmdNavigationMetrics().index === 0')
            page.locator('.bmd-change-title').nth(2).click()
            page.wait_for_function('window.bmdNavigationMetrics().index === 2')
            assert abs(page.evaluate('window.bmdNavigationMetrics().sourceTop') - source_top) <= 1
            page.evaluate("app.plugins.plugins['better-md-diff'].settings.followNavigation = true")
            page.locator('.bmd-change-title').nth(5).click()
            page.wait_for_function("tolerance => { const m = window.bmdNavigationMetrics(); return m.index === 5 && m.diffError <= 2 && m.sourceError <= tolerance; }", arg=tolerance)
        report['checks'].append('block headings (mouse/Enter) select the first item; changed line numbers select exact items; both center without stealing focus and honor source linkage in all three modes')
        report['checks'].append('body double-click selects text without changing the selected item or source scroll position')
        # Rapid repeated navigation settles at the final item without moving focus to the source.
        page.locator('.bmd-previous').focus()
        page.evaluate("() => { const button = document.querySelector('.bmd-previous'); button.click(); button.click(); button.click(); }")
        page.wait_for_function("() => { const m = window.bmdNavigationMetrics(); return m.index === 2 && m.diffError <= 2 && m.sourceError <= 48; }")
        assert page.locator('.bmd-previous').evaluate('el => document.activeElement === el')
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.getViewData()") == nav_current
        report['checks'].append('centered change navigation in source/Live Preview/reading, nearby edits, deletion, start/end, repeated clicks, source-link toggle and focus preservation')
        # A change larger than the diff viewport must reveal its beginning, not its midpoint.
        long_nav = nav_current.replace('Changed navigation line 120.', '\n'.join(f'Long inserted line {i}.' for i in range(80)))
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].setViewState({type:'markdown',state:{file:'navigation.md',mode:'source',source:true}})")
        page.evaluate("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.setValue(text)", long_nav)
        page.wait_for_function("text => app.plugins.plugins['better-md-diff'].store.get('navigation.md')?.current === text", arg=long_nav)
        page.evaluate("() => { const p = app.plugins.plugins['better-md-diff']; app.workspace.getLeavesOfType('better-md-diff-view')[0].view.showLine(p.store.get('navigation.md').diff.changes[3].from, true, true); }")
        page.locator('.bmd-next').click()
        page.wait_for_function("() => { const m = window.bmdNavigationMetrics(); return m.index === 4 && m.diffError <= 2 && m.sourceError <= 2; }")
        tall = page.locator('.bmd-diff-body').evaluate("el => { const change = el.querySelector('.bmd-change--selected').getBoundingClientRect(); return {height: change.height, viewport: el.clientHeight, top: change.top - el.getBoundingClientRect().top}; }")
        assert tall['height'] > tall['viewport'] and abs(tall['top'] - 8) <= 2, tall
        report['checks'].append('oversized change starts 8px inside the diff viewport instead of hiding its beginning')
        copy_blocks = page.evaluate("""() => {
          const body = document.querySelector('.bmd-diff-body'), range = document.createRange(); range.selectNodeContents(body);
          const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          const clipboardData = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', {clipboardData, bubbles:true, cancelable:true}));
          const copied = clipboardData.getData('text/plain'); selection.removeAllRanges();
          const expected = [...body.querySelectorAll('.bmd-row-text')].map(el => el.hasAttribute('data-source-empty') ? '' : el.textContent).join('\\n');
          return copied === expected;
        }""")
        assert copy_blocks, 'Cross-block copying must contain only the displayed source rows'
        report['checks'].append('cross-block copy excludes headings, controls and line numbers')
        page.evaluate("delete window.bmdNavigationMetrics")
        # Changed table padding must paint on its own text fragments, never below the block.
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath('spaces.md'))")
        page.evaluate("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.setValue(text)", spaces_current)
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('spaces.md')")
        page.wait_for_function("document.querySelectorAll('.bmd-inline-whitespace[data-symbol^=\"·\"]').length >= 6")
        assert page.locator('.bmd-row').evaluate_all("""rows => rows.every(row => {
          const box = row.getBoundingClientRect();
          return [...row.querySelectorAll('.bmd-inline-whitespace')].every(el => [...el.getClientRects()].every(r =>
            r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1));
        })""")
        assert page.locator('.bmd-row-text').evaluate_all("rows => rows.every(el => el.scrollWidth <= el.clientWidth + 1)")
        space_row = page.locator('.bmd-row--added .bmd-row-text').first
        copied_spaces = space_row.evaluate("""el => {
          const range = document.createRange(); range.selectNodeContents(el);
          const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          const clipboardData = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', {clipboardData, bubbles:true, cancelable:true}));
          const copied = clipboardData.getData('text/plain'); selection.removeAllRanges(); return copied;
        }""")
        assert copied_spaces == spaces_current.split('\n')[0]
        added_jump = page.locator('.bmd-change-title').last
        assert added_jump.inner_text() == str(len(spaces_before.splitlines()) + 1), 'Pure additions need a visible current-side line-number button'
        added_jump.click()
        page.wait_for_function('line => app.workspace.getLeavesOfType("markdown")[0].view.editor.getCursor().line === line', arg=len(spaces_before.splitlines()))
        assert added_jump.evaluate('el => document.activeElement === el')
        page.locator('.bmd-diff-body').evaluate('el => el.scrollTop = el.scrollHeight')
        page.locator('.bmd-panel').screenshot(path=str(case / 'whitespace-end.png'))
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == spaces_current
        report['checks'].append('changed whitespace stays inside its rows and copies as exact source spaces/tabs, without stray dots below the block')
        page.evaluate("async () => { const leaf = app.workspace.getLeavesOfType('markdown')[0]; await leaf.openFile(app.vault.getAbstractFileByPath('sample.md')); await leaf.setViewState({type:'markdown',state:{file:'sample.md',mode:'source',source:true}}); }")
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('sample.md')")
        page.locator('.bmd-revert').first.wait_for()
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
        for source in [True, False]:
            page.evaluate("""async ([text, source]) => {
              const leaf = app.workspace.getLeavesOfType('markdown')[0];
              await leaf.openFile(app.vault.getAbstractFileByPath('alignment.md'));
              await leaf.setViewState({type:'markdown',state:{file:'alignment.md',mode:'source',source}});
              leaf.view.editor.setValue(text);
              leaf.view.editor.setCursor({line:0,ch:0});
              await app.plugins.plugins['better-md-diff'].openDiff('alignment.md');
            }""", [alignment_current, source])
            page.wait_for_function("text => app.plugins.plugins['better-md-diff'].store.get('alignment.md')?.current === text && document.querySelectorAll('.bmd-change').length === 2", arg=alignment_current)
            page.wait_for_function("JSON.stringify([...document.querySelectorAll('.bmd-gutter-marker')].map(el => el.textContent)) === JSON.stringify(['~3','~5'])")
            assert page.locator('.bmd-gutter-marker--deleted').count() == 0
            assert page.locator('.bmd-region-heading').count() == 1
            page.locator('.bmd-gutter-marker').first.click()
            page.wait_for_function("prefix => document.querySelector('.bmd-progress')?.textContent === `${prefix} 1 / 2`", arg=progress_prefix)
            for index in [2, 4, 6, 8, 10]:
                texts = page.locator('.bmd-change').nth(0 if index < 6 else 1).locator('.bmd-row-text').all_text_contents()
                assert texts[texts.index(alignment['before'][index]) + 1] == alignment['after'][index], 'Each old paragraph must be adjacent to its own current text'
            page.locator('.bmd-gutter-marker').nth(1).click()
            page.wait_for_function("prefix => document.querySelector('.bmd-progress')?.textContent === `${prefix} 2 / 2`", arg=progress_prefix)
            assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == alignment_current
            page.wait_for_function("document.querySelectorAll('.notice').length === 0", timeout=20000)
            page.screenshot(path=str(case / ('blank-alignment-source.png' if source else 'blank-alignment-live-preview.png')))
            expected = [
                '\n'.join(alignment['before'][:5] + alignment['after'][5:]),
                '\n'.join(alignment['after'][:6] + alignment['before'][6:]),
            ]
            for index, text in enumerate(expected):
                page.locator('.bmd-revert').nth(index).click()
                page.get_by_role('button', name=confirm_label, exact=True).click()
                page.get_by_role('button', name=confirm_label, exact=True).wait_for(state='hidden')
                page.wait_for_function("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === text", arg=text)
                page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.focus()")
                page.keyboard.press('Meta+z' if os.sys.platform == 'darwin' else 'Control+z')
                page.wait_for_function("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === text", arg=alignment_current)
                page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('alignment.md')")
                page.wait_for_function("text => app.plugins.plugins['better-md-diff'].store.get('alignment.md')?.current === text && document.querySelectorAll('.bmd-change').length === 2", arg=alignment_current)
        page.evaluate("async () => { const leaf = app.workspace.getLeavesOfType('markdown')[0]; await leaf.setViewState({type:'markdown',state:{file:'alignment.md',mode:'source',source:true}}); }")
        report['checks'].append('repeated blanks keep old/new paragraphs paired, show only ~3/~5 flags, and restore either group independently with native undo in source and Live Preview')
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath('items.md'))")
        page.evaluate("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.setValue(text)", items_current)
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('items.md')")
        page.wait_for_function("document.querySelectorAll('.bmd-change').length === 4")
        assert page.locator('.bmd-diff-region').count() == 1
        assert page.locator('.bmd-hunk').count() == 0
        deletion_marker = page.locator('.bmd-gutter-marker--deleted').first
        deletion_marker.wait_for()
        assert deletion_marker.inner_text() == '−1'
        marker_rgb = deletion_marker.evaluate("el => { const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); ctx.fillStyle = getComputedStyle(el, '::before').backgroundColor; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); }")
        assert marker_rgb[0] > marker_rgb[1] and marker_rgb[0] > marker_rgb[2], 'Deletion marker should use the red theme token'
        report['deletion_marker_rgb'] = marker_rgb
        assert page.locator('.cm-line.bmd-line--deleted').count() == 0
        assert page.locator('.cm-line.bmd-deletion-anchor').count() == 0
        assert deletion_marker.evaluate("el => getComputedStyle(el, '::before').clipPath !== 'none'")
        assert page.locator('.bmd-gutter-range--deleted').first.evaluate("el => getComputedStyle(el, '::before').content === 'none'")
        assert page.locator('.bmd-change-actions').count() == 0
        rows = page.locator('.bmd-change').nth(1).locator('.bmd-row').all()
        row_boxes = [row.bounding_box() for row in rows]
        assert abs(row_boxes[0]['y'] + row_boxes[0]['height'] - row_boxes[1]['y']) < 1, 'Old/new rows should be adjacent'
        context = page.locator('.bmd-row--context .bmd-row-text').first
        added_text = page.locator('.bmd-row--added .bmd-row-text').first
        deleted_text = page.locator('.bmd-row--deleted .bmd-row-text').first
        assert context.evaluate('el => getComputedStyle(el).color') != added_text.evaluate('el => getComputedStyle(el).color'), 'Added text must use green rather than the context color'
        assert deleted_text.evaluate('el => getComputedStyle(el).color') != added_text.evaluate('el => getComputedStyle(el).color'), 'Old and new text must have distinct red/green foregrounds'
        deletion_marker.click()
        page.wait_for_function("document.querySelector('.bmd-row--deleted.bmd-row--current .bmd-row-text')?.textContent === '升级时：'")
        report['checks'].append('deletion boundary flag opens the old row without a source rule, tint or mutation; adjacent old/new rows use red/green text')
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
                header = page.locator('.bmd-panel').evaluate("""el => {
                  const panel = el.getBoundingClientRect(), toolbar = el.querySelector('.bmd-toolbar').getBoundingClientRect();
                  const controls = [...el.querySelectorAll('.bmd-toolbar button, .bmd-progress')].map(node => node.getBoundingClientRect());
                  return {height: el.querySelector('.bmd-diff-body').getBoundingClientRect().top - panel.top,
                    toolbarWidth: toolbar.width, toolbarContent: el.querySelector('.bmd-toolbar').scrollWidth,
                    aligned: controls.every(rect => Math.abs(rect.top + rect.height / 2 - toolbar.top - toolbar.height / 2) < 2),
                    nonOverlapping: controls.every((rect, i) => !i || rect.left >= controls[i - 1].right)};
                }""")
                assert header['height'] <= 130 and header['aligned'] and header['nonOverlapping'], header
                assert header['toolbarContent'] <= header['toolbarWidth'] + 1, header
                palette = page.locator('.bmd-panel').evaluate("""panel => {
                  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                  const ctx = canvas.getContext('2d');
                  const pixel = () => [...ctx.getImageData(0,0,1,1).data].slice(0,3);
                  const rgb = color => { ctx.clearRect(0,0,1,1); ctx.fillStyle = color; ctx.fillRect(0,0,1,1); return pixel(); };
                  const background = el => {
                    const ancestors = []; for (let node = el; node; node = node.parentElement) ancestors.push(node);
                    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,1,1);
                    for (const node of ancestors.reverse()) { ctx.fillStyle = getComputedStyle(node).backgroundColor; ctx.fillRect(0,0,1,1); }
                    return pixel();
                  };
                  const luminance = rgb => rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126,0.7152,0.0722][i], 0);
                  const ratio = (a, b) => (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
                  const probe = document.createElement('span'); probe.style.color = 'var(--text-normal)'; panel.append(probe);
                  const normal = rgb(getComputedStyle(probe).color); probe.remove();
                  const samples = [...panel.querySelectorAll('.bmd-row-text, mark.bmd-inline-change')].map(el => {
                    const fg = rgb(getComputedStyle(el).color), bg = background(el);
                    return {kind:el.closest('.bmd-row').classList.contains('bmd-row--added') ? 'added' : el.closest('.bmd-row').classList.contains('bmd-row--deleted') ? 'deleted' : 'context',
                      highlight:el.matches('mark'), selected:el.closest('.bmd-row').matches('.bmd-row--current, .bmd-row--paired'), fg, bg, contrast:ratio(luminance(fg),luminance(bg))};
                  });
                  return {normal, samples};
                }""")
                for sample in palette['samples']:
                    red, green, blue = sample['fg']
                    if sample['kind'] == 'added': assert green > red and green > blue, sample
                    elif sample['kind'] == 'deleted': assert red > green and red > blue, sample
                    else: assert sample['fg'] == palette['normal'], sample
                    assert sample['contrast'] >= 4.5, {'theme':theme, **sample}
                assert any(sample['highlight'] for sample in palette['samples']) and any(sample['selected'] for sample in palette['samples'])
                report['change_layouts'].append({'theme': theme, 'panelWidth': width, **dimensions, 'header': header, 'palette':palette})
                page.locator('.bmd-panel').screenshot(path=str(case / f'panel-changes-{theme}-{width}.png'))
        report['checks'].append('light/dark changes at 280/440px: restore controls do not cover text or cause horizontal overflow')
        report['checks'].append('red deleted / green added text, normal context, and at least 4.5:1 contrast on row, selected-row and changed-word backgrounds in both default themes')
        text_colors = page.locator('.bmd-row-text').evaluate_all("els => els.map(el => getComputedStyle(el).color)")
        page.evaluate("async () => { const p = app.plugins.plugins['better-md-diff']; p.settings.inlineHighlights = false; await p.applySettings(); }")
        page.wait_for_function("document.querySelector('.bmd-panel.bmd-no-inline-highlights')")
        assert page.locator('.bmd-row-text').evaluate_all("els => els.map(el => getComputedStyle(el).color)") == text_colors
        assert page.locator('mark.bmd-inline-change').evaluate_all("els => els.length > 0 && els.every(el => getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)')")
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == items_current
        page.evaluate("async () => { const p = app.plugins.plugins['better-md-diff']; p.settings.inlineHighlights = true; await p.applySettings(); }")
        page.wait_for_function("document.querySelector('.bmd-panel:not(.bmd-no-inline-highlights)')")
        report['checks'].append('disabling changed-word highlighting preserves red/green text and source content; re-enabling restores the existing display setting')
        page.evaluate("document.body.classList.remove('theme-dark'); document.body.classList.add('theme-light')")
        # Range flags occupy only the fixed gutter, including wrapped logical lines.
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath('flags.md'))")
        page.evaluate("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.setValue(text)", flags_current)
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('flags.md')")
        page.wait_for_function("document.querySelectorAll('.bmd-change').length === 3")
        report['source_flags'] = []
        for source in [True, False]:
            page.evaluate("source => app.workspace.getLeavesOfType('markdown')[0].setViewState({type:'markdown',state:{file:'flags.md',mode:'source',source}})", source)
            page.wait_for_function("[...document.querySelectorAll('.bmd-gutter-marker')].map(el => el.textContent).join(',') === '+3,~2,−2'")
            for theme in ['light', 'dark']:
                page.evaluate("theme => { document.body.classList.remove('theme-light','theme-dark'); document.body.classList.add('theme-' + theme); }", theme)
                metrics = page.locator('.bmd-gutter').evaluate("""gutter => {
                  const ranges = kind => [...gutter.querySelectorAll('.bmd-gutter-range--' + kind)];
                  const geometry = kind => ranges(kind).map(el => {
                    const box = el.getBoundingClientRect(), rail = getComputedStyle(el, '::before');
                    return {top:box.top, bottom:box.bottom, height:box.height, railTop:parseFloat(rail.top), railBottom:parseFloat(rail.bottom), lineHeight:parseFloat(el.style.getPropertyValue('--bmd-source-line-height'))};
                  });
                  return {width:gutter.getBoundingClientRect().width, added:geometry('added'), modified:geometry('modified'),
                    noDeletionRail:ranges('deleted').every(el => getComputedStyle(el, '::before').content === 'none'),
                    flags:[...gutter.querySelectorAll('button')].map(el => ({text:el.textContent, width:el.getBoundingClientRect().width, height:el.getBoundingClientRect().height, label:el.title}))};
                }""")
                assert metrics['width'] == 32 and metrics['noDeletionRail'], metrics
                assert len(metrics['added']) == 3 and len(metrics['modified']) == 2, metrics
                for kind in ['added', 'modified']:
                    parts = metrics[kind]
                    assert abs(parts[0]['railTop'] - parts[0]['lineHeight'] / 2) < 1, metrics
                    assert abs(parts[-1]['railBottom'] - parts[-1]['lineHeight'] / 2) < 1, metrics
                    assert parts[-1]['height'] > parts[-1]['lineHeight'] * 1.5, 'Fixture must include wrapped last rows'
                    assert all(abs(left['bottom'] - right['top']) < 1 for left, right in zip(parts, parts[1:])), metrics
                assert all(flag['width'] == 28 and flag['height'] <= 20 and flag['label'] for flag in metrics['flags']), metrics
                assert page.locator('.cm-line.bmd-line, .cm-line.bmd-deletion-anchor').count() == 0
                flag = page.locator('.bmd-gutter-marker--modified')
                flag.focus()
                page.keyboard.press('Tab'); page.keyboard.press('Shift+Tab')
                assert flag.evaluate("el => document.activeElement === el && getComputedStyle(el).outlineStyle !== 'none' && getComputedStyle(el).outlineOffset === '-2px'")
                page.keyboard.press('Enter')
                page.wait_for_function("text => document.querySelector('.bmd-progress').textContent === text", arg=f'{progress_prefix} 2 / 3')
                assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == flags_current
                report['source_flags'].append({'source':source, 'theme':theme, **metrics})
                page.screenshot(path=str(case / f'flags-{source}-{theme}.png'))
        report['checks'].append('counted add/modify flags with connected wrapped-line ranges, deletion-only boundary, fixed gutter, keyboard focus and navigation in source/Live Preview and both themes')
        page.evaluate("document.body.classList.remove('theme-dark'); document.body.classList.add('theme-light')")
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath('blocks.md'))")
        page.evaluate("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.setValue(text)", blocks_current)
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('blocks.md')")
        page.wait_for_function("document.querySelectorAll('.bmd-change').length === 3")
        page.wait_for_function("document.querySelector('.markdown-source-view.is-live-preview table') && document.querySelector('.bmd-gutter-range--block .bmd-gutter-marker')")
        table_flag = page.locator('.bmd-gutter-range--block .bmd-gutter-marker').first
        assert table_flag.inner_text() == '~1'
        assert table_flag.evaluate("el => getComputedStyle(el.parentElement, '::before').content === 'none'")
        table_flag.click()
        page.wait_for_function("text => document.querySelector('.bmd-progress').textContent === text", arg=f'{progress_prefix} 1 / 3')
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.focus()")
        assert page.evaluate("app.commands.executeCommandById('editor:fold-all')"), 'Native fold command must be available'
        page.wait_for_function("document.querySelector('.bmd-gutter-range--block .bmd-gutter-marker')?.title.includes('3')")
        assert page.locator('.bmd-gutter-range--block .bmd-gutter-marker').first.inner_text() == '~1', 'Do not turn three independent changes into a ~3 line count'
        page.locator('.bmd-gutter-range--block .bmd-gutter-marker').first.click()
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == blocks_current
        report['checks'].append('real Live Preview table and native folded document retain a labeled first-change flag without fake range rails or merged operation counts')
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.setValue('')")
        page.wait_for_function("document.querySelector('.bmd-gutter-marker--deleted')?.textContent === '−13'")
        edge = page.locator('.bmd-gutter-marker--deleted').evaluate("""el => {
          const flag = el.getBoundingClientRect(), row = el.parentElement.getBoundingClientRect(), label = el.querySelector('.bmd-gutter-label');
          return {top:flag.top - row.top, bottom:row.bottom - flag.bottom, labelWidth:label.clientWidth, labelContent:label.scrollWidth};
        }""")
        assert edge['top'] >= 0 and edge['bottom'] >= 0, edge
        assert edge['labelContent'] <= edge['labelWidth'], 'Two-digit counts must remain readable inside the fixed flag'
        page.locator('.bmd-gutter-marker--deleted').click()
        page.wait_for_function("text => document.querySelector('.bmd-progress').textContent === text", arg=f'{progress_prefix} 1 / 1')
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == ''
        report['checks'].append('empty-document deletion flag stays inside the first row, preserves a two-digit count and opens the deleted text')
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
        # Exercise independent scrolling and a long file name with statistics in the narrow panel.
        reading_text = ''.join(f'Generated reading line {i}\n' for i in range(120))
        page.evaluate("text => app.workspace.getLeavesOfType('markdown')[0].view.editor.setValue(text)", reading_text)
        page.wait_for_function("text => app.plugins.plugins['better-md-diff'].store.get(app.workspace.getLeavesOfType('markdown')[0].view.file.path)?.current === text", arg=reading_text)
        page.locator('.workspace-split.mod-right-split').evaluate("el => { el.style.width = '280px'; el.style.flexBasis = '280px'; }")
        page.wait_for_function("Math.abs(document.querySelector('.bmd-panel').getBoundingClientRect().width - 280) < 0.1")
        page.wait_for_function("document.querySelectorAll('.notice').length === 0", timeout=20000)
        assert page.locator('.bmd-file-info').get_attribute('title') == clean_path
        toolbar_box = page.locator('.bmd-toolbar').bounding_box()
        summary_box = page.locator('.bmd-summary').bounding_box()
        assert summary_box['y'] + summary_box['height'] - page.locator('.bmd-panel').bounding_box()['y'] <= 130
        page.locator('.bmd-panel').screenshot(path=str(case / 'panel-long-name-dark-280.png'))
        scrolled = page.locator('.bmd-diff-body').evaluate('el => { el.scrollTop = el.scrollHeight; return el.scrollTop; }')
        assert scrolled > 0
        for selector, before_box in [('.bmd-toolbar', toolbar_box), ('.bmd-summary', summary_box)]:
            after_box = page.locator(selector).bounding_box()
            assert all(abs(after_box[key] - before_box[key]) <= 1 for key in before_box), (selector, before_box, after_box)
        report['checks'].append('long path and statistics stay compact at 280px; diff scrolling leaves toolbar and summary fixed')
        page.locator('.bmd-help-button').click()
        page.locator('.bmd-reading-guide').wait_for()
        page.evaluate("app.workspace.getLeavesOfType('better-md-diff-view')[0].detach()")
        page.locator('.bmd-reading-guide').wait_for(state='hidden')
        report['checks'].append('closing the diff pane cleans up its reading guide')
        page.evaluate("app.workspace.getLeavesOfType('markdown')[0].openFile(app.vault.getAbstractFileByPath('sample.md'))")
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('sample.md')")
        page.locator('.bmd-revert').first.wait_for()
        # Before unloading, open confirmation to exercise abort/cleanup in the actual host.
        page.locator('.bmd-revert').first.click()
        page.evaluate("app.plugins.disablePlugin('better-md-diff')")
        assert page.get_by_role('button', name=confirm_label, exact=True).count() == 0
        assert page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()") == current
        report['checks'].append('unload closes confirmation without writing')
        # Test popout behavior last; the isolated process teardown owns both windows.
        # CDP force-closing a popout can leave stale host leaves or hang old Electron IPC.
        page.evaluate("app.plugins.enablePlugin('better-md-diff')")
        page.evaluate("app.plugins.plugins['better-md-diff'].openDiff('sample.md')")
        # The reading guide must use the active popout's document, not cover the main window.
        with page.context.expect_page() as opened:
            page.evaluate("() => { app.workspace.moveLeafToPopout(app.workspace.getLeavesOfType('better-md-diff-view')[0], {width: 480, height: 640}); }")
        popout = opened.value
        popout.locator('.bmd-help-button').wait_for()
        popout.bring_to_front()
        # CDP foregrounding does not deliver the native window-focus event used by Obsidian.
        # Activate through that event, never by replacing the host's activeWindow global.
        popout.evaluate("window.dispatchEvent(new Event('focus'))")
        popout.locator('.bmd-help-button').focus()
        popout.keyboard.press('Enter')
        popout.locator('.bmd-reading-guide').wait_for()
        assert page.locator('.bmd-reading-guide').count() == 0
        popout.screenshot(path=str(case / 'popout-reading-guide.png'))
        popout.keyboard.press('Escape')
        popout.locator('.bmd-reading-guide').wait_for(state='hidden')
        assert popout.locator('.bmd-help-button').evaluate('el => document.activeElement === el')
        report['checks'].append('reading guide opens in the active popout and Escape restores its help-button focus (explicit host activation event under CDP)')
        assert not report.get('page_errors'), report['page_errors']
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
