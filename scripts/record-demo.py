"""Record the real plugin in an isolated Obsidian vault, then caption and encode a GIF.
Requires Python Playwright, Pillow, FFmpeg and an explicit Obsidian executable.
No interactive demo, browser mock, personal vault, existing profile or desktop capture.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time

from PIL import Image, ImageDraw, ImageFont
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
NOTE = 'Pride and Prejudice.md'
REMOVED = 'Mr. Bennet replied that he had not.\n'
ADDED = '\n> Reading note: Austen makes marriage a social expectation.\n'
WIDTH, HEIGHT, FOOTER = 1120, 760, 88
SCENES = [
    'Edit a word. See exactly what changed.',
    'Click the deletion marker to find the missing sentence.',
    'Confirm the preview. Restore only this change.',
    'Undo in the editor. Your other edits stay intact.',
]


def git(vault, *command):
    return subprocess.run(['git', *command], cwd=vault, check=True, capture_output=True, text=True).stdout.strip()


def stop_owned_process(process):
    if process and process.poll() is None:
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, check=True)
        else:
            process.terminate()
            process.wait(timeout=20)


async def connect_host(pw, process, port):
    for _ in range(60):
        if process.poll() is not None:
            raise RuntimeError('The owned Obsidian process exited; refusing to attach to another instance.')
        try:
            return await pw.chromium.connect_over_cdp(f'http://127.0.0.1:{port}', timeout=1000)
        except Exception:
            await asyncio.sleep(0.5)
    raise RuntimeError('Isolated Obsidian did not expose CDP. See host.log.')


async def assert_vault(page, vault):
    await page.wait_for_function('typeof app !== "undefined" && app.vault && app.workspace?.layoutReady', timeout=60000)
    actual = await page.evaluate('app.vault.adapter.getBasePath()')
    if Path(actual).resolve() != vault.resolve():
        raise RuntimeError('Vault identity mismatch; no note data was accessed.')


async def record(args, case, report):
    vault, profile = case / 'Literary demo', case / 'profile'
    vault.mkdir(); profile.mkdir()
    config = vault / '.obsidian'
    plugin_dir = config / 'plugins' / 'better-md-diff'
    plugin_dir.mkdir(parents=True)
    for name in ['main.js', 'manifest.json', 'styles.css']:
        source = ROOT / 'dist' / 'better-md-diff' / name
        shutil.copyfile(source, plugin_dir / name)
        report.setdefault('build_sha256', {})[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    (config / 'community-plugins.json').write_text('["better-md-diff"]', encoding='utf-8')
    (config / 'app.json').write_text(json.dumps({
        'livePreview': False, 'showLineNumber': True, 'showInlineTitle': False,
        'readableLineLength': False, 'baseFontSize': 16, 'theme': 'moonstone',
    }), encoding='utf-8')
    (plugin_dir / 'data.json').write_text(json.dumps({'fontSize': 14, 'contextLines': 2}), encoding='utf-8')
    (profile / 'obsidian.json').write_text(json.dumps({
        'vaults': {'bmd-literature-demo': {'path': str(vault), 'ts': int(time.time() * 1000), 'open': True}},
        'autoUpdate': False,
    }), encoding='utf-8')
    baseline = (ROOT / 'scripts' / 'fixtures' / 'pride-and-prejudice.md').read_text(encoding='utf-8')
    assert baseline.count(REMOVED) == 1 and baseline.count('universally') == 1
    (vault / NOTE).write_text(baseline, encoding='utf-8')
    hooks = case / 'empty-hooks'; hooks.mkdir()
    git(vault, '-c', f'init.templateDir={hooks}', 'init', '-q')
    for key, value in [('user.name', 'Better MD Diff Demo'), ('user.email', 'demo@example.invalid'),
                       ('commit.gpgsign', 'false'), ('core.autocrlf', 'false'), ('core.hooksPath', str(hooks))]:
        git(vault, 'config', key, value)
    git(vault, 'add', NOTE)
    git(vault, 'commit', '-qm', 'Public-domain excerpt: Jane Austen, chapter I')
    head = git(vault, 'rev-parse', 'HEAD')
    index = git(vault, 'write-tree')
    working = baseline.replace(REMOVED, '') + ADDED
    edited = working.replace('universally', 'widely')
    restored = baseline.replace('universally', 'widely') + ADDED
    report.update({'vault': str(vault), 'baseline_head': head, 'language': 'en', 'viewport': [WIDTH, HEIGHT]})
    (case / 'before.md').write_text(baseline, encoding='utf-8')
    (case / 'working.md').write_text(edited, encoding='utf-8')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    launch = [args.executable, f'--user-data-dir={profile}', f'--remote-debugging-port={port}', '--disable-background-networking']
    process = None
    frames, scene, click = [], 0, None
    capturing = False
    capture_task = None
    raw = case / 'raw'; raw.mkdir()
    with (case / 'host.log').open('w', encoding='utf-8') as log:
        try:
            process = subprocess.Popen(launch, stdout=log, stderr=log)
            async with async_playwright() as pw:
                browser = await connect_host(pw, process, port)
                context = browser.contexts[0]
                page = context.pages[0]
                await assert_vault(page, vault)
                if await page.evaluate("localStorage.getItem('language') || 'en'") != 'en':
                    await page.evaluate("localStorage.setItem('language', 'en')")
                    await page.close(run_before_unload=True)
                    await asyncio.to_thread(process.wait, timeout=20)
                    process = subprocess.Popen(launch, stdout=log, stderr=log)
                    browser = await connect_host(pw, process, port)
                    context = browser.contexts[0]; page = context.pages[0]
                    await assert_vault(page, vault)
                # Deny network requests from the owned renderer; all footage uses local content.
                await context.route(re.compile(r'^https?://'), lambda route: route.abort())
                page.on('pageerror', lambda error: report.setdefault('page_errors', []).append(str(error)))
                page.on('console', lambda message: report.setdefault('console_errors', []).append(message.text) if message.type == 'error' else None)
                trust = page.get_by_role('button', name=re.compile('Trust author and enable plugins|信任仓库作者并启用插件', re.I))
                await page.wait_for_function("app.plugins.plugins['better-md-diff']?.store || [...document.querySelectorAll('button')].some(b => /Trust author and enable plugins|信任仓库作者并启用插件/i.test(b.textContent))")
                if await trust.is_visible():
                    await trust.click(); await trust.wait_for(state='hidden')
                    # Trust completion opens settings asynchronously, after enabling the plugin.
                    # Observe that real boundary before closing; an early close races the host.
                    await page.locator('.modal-container').filter(has_text='Restricted mode').wait_for()
                await page.wait_for_function("app.plugins.plugins['better-md-diff']?.store")
                await page.evaluate('app.setting.close()')
                await page.keyboard.press('Escape')
                await page.locator('.modal-container').wait_for(state='hidden')
                await page.set_viewport_size({'width': WIDTH, 'height': HEIGHT})
                await page.evaluate("""async ({note, text}) => {
                    const leaf = app.workspace.getLeaf(false);
                    await leaf.openFile(app.vault.getAbstractFileByPath(note));
                    await leaf.setViewState({type:'markdown', state:{file:note, mode:'source', source:true}});
                    leaf.view.editor.setValue(text);
                    app.workspace.leftSplit.collapse();
                    await app.plugins.plugins['better-md-diff'].openDiff(note);
                }""", {'note': NOTE, 'text': working})
                await page.locator('.workspace-split.mod-right-split').evaluate("el => { el.style.width = '460px'; el.style.flexBasis = '460px'; el.style.flexGrow = '0'; }")
                await page.locator('.bmd-refresh').filter(has_text='Refresh').wait_for()
                await page.wait_for_function("document.querySelectorAll('.bmd-change').length === 2")
                await page.wait_for_function("document.querySelectorAll('.notice').length === 0", timeout=60000)
                await page.evaluate("""() => {
                    const editor = app.workspace.getLeavesOfType('markdown')[0].view.editor;
                    editor.setCursor({line: 2, ch: 0}); editor.scrollTo(null, 0);
                }""")
                report['checks'].append('Owned English Obsidian vault, real Git baseline, real installed build')

                async def capture():
                    while capturing:
                        began = time.monotonic()
                        data = await page.screenshot(type='png', timeout=5000)
                        stamp = time.monotonic()
                        filename = f'{len(frames):05d}.png'
                        (raw / filename).write_bytes(data)
                        frames.append({'file': filename, 'time': stamp, 'scene': scene,
                                       'click': click[0] if click and stamp < click[1] else None})
                        await asyncio.sleep(max(0, 0.125 - (time.monotonic() - began)))

                async def click_control(locator):
                    nonlocal click
                    await locator.scroll_into_view_if_needed()
                    box = await locator.bounding_box()
                    click = ([box['x'] + box['width'] / 2, box['y'] + box['height'] / 2], time.monotonic() + 0.9)
                    await locator.click()

                async def expect_text(text):
                    try:
                        await page.wait_for_function("expected => app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue() === expected", arg=text, timeout=10000)
                    except Exception:
                        (case / 'unexpected-buffer.md').write_text(await page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.getValue()"), encoding='utf-8')
                        report['visible_modals'] = await page.locator('.modal-container').all_text_contents()
                        raise

                capturing = True
                capture_task = asyncio.create_task(capture())
                # Intentional reading pauses are part of the continuous capture, not readiness waits.
                await asyncio.sleep(2)
                await page.evaluate("""() => {
                    const editor = app.workspace.getLeavesOfType('markdown')[0].view.editor;
                    const offset = editor.getValue().indexOf('universally');
                    editor.setSelection(editor.offsetToPos(offset), editor.offsetToPos(offset + 'universally'.length));
                    editor.focus();
                }""")
                await page.keyboard.type('widely', delay=100)
                await expect_text(edited)
                await page.wait_for_function("document.querySelectorAll('.bmd-change').length === 3")
                changed_row = page.locator('.bmd-row--added').filter(has_text='It is a truth widely acknowledged,')
                assert await changed_row.locator('.bmd-inline-added').count() > 0, 'The edited sentence must contain fine-grained highlights'
                report['checks'].append('Real keyboard editing updates word-level highlights and three independent changes')
                await asyncio.sleep(3)

                scene = 1
                await asyncio.sleep(0.6)
                await click_control(page.locator('.bmd-gutter-marker--deleted'))
                await page.wait_for_function("document.querySelector('.bmd-row--deleted.bmd-row--current .bmd-row-text')?.textContent === 'Mr. Bennet replied that he had not.'")
                await expect_text(edited)
                report['checks'].append('Deletion badge reveals the exact old sentence without modifying source')
                await asyncio.sleep(3.5)

                scene = 2
                target = page.locator('.bmd-change').filter(has_text='Mr. Bennet replied that he had not.')
                await click_control(target.locator('.bmd-revert'))
                await page.get_by_role('button', name='Confirm restoration', exact=True).wait_for()
                assert await page.locator('.bmd-revert-preview--deleted').inner_text() == REMOVED.rstrip('\n')
                await asyncio.sleep(3.5)
                await click_control(page.get_by_role('button', name='Confirm restoration', exact=True))
                await expect_text(restored)
                await page.wait_for_function("document.querySelectorAll('.bmd-change').length === 2")
                report['checks'].append('Confirmed restoration recovers only the deletion; the word edit and reading note remain')
                await asyncio.sleep(3)

                scene = 3
                await asyncio.sleep(1)
                await page.evaluate("app.workspace.getLeavesOfType('markdown')[0].view.editor.focus()")
                await page.keyboard.press('Meta+z' if os.sys.platform == 'darwin' else 'Control+z')
                await expect_text(edited)
                await page.wait_for_function("document.querySelectorAll('.bmd-change').length === 3")
                await click_control(page.locator('.bmd-gutter-marker--deleted'))
                report['checks'].append('Native editor undo restores the complete pre-restoration buffer')
                await asyncio.sleep(4)
                capturing = False
                await capture_task
                capture_task = None
                assert git(vault, 'rev-parse', 'HEAD') == head
                assert git(vault, 'write-tree') == index
                assert git(vault, 'show', f'HEAD:{NOTE}') == baseline.rstrip('\n')
                report['checks'].append('Git HEAD and index remain unchanged throughout recording')
                assert not report.get('page_errors') and not report.get('console_errors'), 'Host errors: inspect report.json'
        except Exception as error:
            report['primary_error'] = f'{type(error).__name__}: {error}'
            raise
        finally:
            capturing = False
            try:
                if capture_task:
                    try:
                        await capture_task
                    except Exception as capture_error:
                        report['capture_error'] = str(capture_error)
                        if 'primary_error' not in report:
                            raise
            finally:
                stop_owned_process(process)
                (case / 'frames.json').write_text(json.dumps(frames, indent=2), encoding='utf-8')
    if len(frames) < 2:
        raise RuntimeError('No continuous recording was captured.')
    return frames


def load_font(size, bold=False):
    candidates = [Path('C:/Windows/Fonts') / ('segoeuib.ttf' if bold else 'segoeui.ttf'),
                  Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default(size=size)


def encode(args, case, frames, report):
    rendered = case / 'captioned'; rendered.mkdir()
    title_font, credit_font = load_font(21, True), load_font(14)
    concat = []
    for i, frame in enumerate(frames):
        with Image.open(case / 'raw' / frame['file']) as capture:
            assert capture.size == (WIDTH, HEIGHT), f'Unexpected viewport: {capture.size}'
            image = Image.new('RGB', (WIDTH, HEIGHT + FOOTER), '#f5f5f7')
            image.paste(capture, (0, 0))
        draw = ImageDraw.Draw(image)
        draw.line((0, HEIGHT, WIDTH, HEIGHT), fill='#d0d0d8', width=1)
        draw.text((24, HEIGHT + 13), f"0{frame['scene'] + 1} / {SCENES[frame['scene']]}", font=title_font, fill='#25252b')
        draw.text((24, HEIGHT + 51), 'Jane Austen · Pride and Prejudice (1813)  |  Demo edits to a public-domain excerpt', font=credit_font, fill='#525260')
        if frame['click']:
            x, y = frame['click']
            draw.ellipse((x - 16, y - 16, x + 16, y + 16), outline='#7357bd', width=3)
        image.save(rendered / frame['file'])
        next_time = frames[i + 1]['time'] if i + 1 < len(frames) else frame['time'] + 0.125
        concat.extend([f"file 'captioned/{frame['file']}'", f"duration {max(0.01, next_time - frame['time']):.4f}"])
    concat.append(f"file 'captioned/{frames[-1]['file']}'")
    (case / 'frames.ffconcat').write_text('\n'.join(concat) + '\n', encoding='utf-8')
    target = ROOT / 'docs' / 'images'; target.mkdir(exist_ok=True, parents=True)
    output = case / 'obsidian-demo.gif'
    subprocess.run([args.ffmpeg, '-hide_banner', '-loglevel', 'warning', '-y', '-f', 'concat', '-safe', '0',
                    '-i', str(case / 'frames.ffconcat'), '-filter_complex',
                    '[0:v]fps=8,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
                    '-loop', '0', str(output)], check=True)
    with Image.open(output) as gif:
        assert gif.is_animated and gif.info.get('loop') == 0
        duration = 0
        for i in range(gif.n_frames):
            gif.seek(i); duration += gif.info.get('duration', 0)
        assert abs(duration / 1000 - (frames[-1]['time'] - frames[0]['time'])) < 1
        report['gif'] = {'width': gif.width, 'height': gif.height, 'frames': gif.n_frames,
                         'seconds': duration / 1000, 'bytes': output.stat().st_size}
    poster = [frame for frame in frames if frame['scene'] == 1][-1]
    shutil.copyfile(output, target / 'obsidian-demo.gif')
    shutil.copyfile(rendered / poster['file'], target / 'obsidian-demo.png')
    report['artifacts'] = ['docs/images/obsidian-demo.gif', 'docs/images/obsidian-demo.png']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', required=True, help='Path to the Obsidian executable')
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'), help='FFmpeg executable (defaults to PATH)')
    args = parser.parse_args()
    if not Path(args.executable).is_file() or not args.ffmpeg:
        parser.error('An existing Obsidian executable and FFmpeg are required.')
    (ROOT / '.test-vault').mkdir(exist_ok=True)
    case = Path(tempfile.mkdtemp(prefix='demo-', dir=ROOT / '.test-vault'))
    report = {'checks': [], 'capture': 'Continuous screenshots of the owned Obsidian renderer, with original timing; only captions and click rings are composited.'}
    try:
        frames = asyncio.run(record(args, case, report))
        encode(args, case, frames, report)
        report['status'] = 'passed'
    except Exception as error:
        report.update({'status': 'failed', 'error': str(error)})
        raise
    finally:
        (case / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
        print(f'Evidence: {case}')


if __name__ == '__main__':
    main()
