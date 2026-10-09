"""Chromium regression for whitespace decoration using the real renderer and stylesheet.
Requires Python Playwright and its Chromium browser; uses only generated content.
"""
import json
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

repo = Path(__file__).resolve().parents[1]
work = repo / '.test-vault'
work.mkdir(exist_ok=True)
case = Path(tempfile.mkdtemp(prefix='whitespace-', dir=work))
bundle = case / 'render.js'
subprocess.run(['node', '--input-type=module', '-e', """
import {build} from 'esbuild';
await build({stdin:{contents:`
import {renderHighlightedText} from './src/inline-diff';
import {installObsidianDom} from './tests/helpers/obsidian-dom';
installObsidianDom(document);
window.renderFixture = (text) => {
  const code = document.querySelector('.bmd-row-text');
  renderHighlightedText(code, {kind:'added',text,oldLine:null,newLine:1}, [{text,changed:true}]);
};`, resolveDir:process.cwd(), loader:'ts'}, bundle:true, format:'iife', outfile:process.argv[1]});
""", str(bundle)], cwd=repo, check=True)
report = {'cases': [], 'failures': []}
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 900, 'height': 750})
    page.set_content('''<style>
      :root { --font-monospace: monospace; --font-ui-small: 13px; --text-normal: #222;
        --background-modifier-border: #aaa; --background-primary: #fff; --color-green-rgb: 10,160,70; }
      * { box-sizing: border-box; }
      .fixture { width: 440px; }
    </style><div class="fixture"><div class="bmd-diff-region"><div class="bmd-lines">
      <div class="bmd-row bmd-row--added"><span>1</span><span>1</span><span>+</span><code class="bmd-row-text"></code></div>
    </div></div></div>''')
    page.add_style_tag(path=str(repo / 'styles.css'))
    page.add_script_tag(path=str(bundle))
    session = page.context.new_cdp_session(page)
    fixtures = ['| action | saved state' + ' ' * 40 + '|', 'prefix ' + ' ' * 80 + 'suffix', ' ' * 80, ' ' * 50000, 'before\t \t after', '中文说明' * 8 + ' ' * 40 + '|']
    for width in [280, 440, 480]:
        for size in [13, 18]:
            for index, text in enumerate(fixtures):
                page.locator('.fixture').evaluate('(el, v) => { el.style.width = `${v.width}px`; el.style.setProperty("--bmd-font-size", `${v.size}px`); }', {'width': width, 'size': size})
                page.evaluate('text => window.renderFixture(text)', text)
                row = page.locator('.bmd-row').bounding_box()
                # CDP exposes actual ::after boxes, unlike jsdom or a cloned approximation.
                root = session.send('DOM.getDocument')['root']['nodeId']
                nodes = session.send('DOM.querySelectorAll', {'nodeId': root, 'selector': '.bmd-inline-whitespace'})['nodeIds']
                leaks = []
                for node in nodes:
                    for pseudo in session.send('DOM.describeNode', {'nodeId': node})['node'].get('pseudoElements', []):
                        model = session.send('DOM.getBoxModel', {'nodeId': pseudo['nodeId']})['model']['border']
                        if max(model[1::2]) > row['y'] + row['height'] + 1 or min(model[::2]) < row['x'] - 1 or max(model[::2]) > row['x'] + row['width'] + 1:
                            leaks.append(model)
                fragments_fit = page.locator('.bmd-row').evaluate('''row => {
                  const box = row.getBoundingClientRect();
                  return [...row.querySelectorAll('.bmd-inline-whitespace')].every(el => [...el.getClientRects()].every(r =>
                    r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1));
                }''')
                assert fragments_fit, 'Source whitespace fragments must stay within the row'
                space = page.locator('.bmd-inline-whitespace[data-symbol^="·"]').first
                assert space.evaluate('el => getComputedStyle(el).backgroundImage !== "none" || !["none", "normal"].includes(getComputedStyle(el, "::after").content)'), 'Spaces must remain visible'
                dimensions = page.locator('.bmd-row-text').evaluate('el => ({width:el.clientWidth, scroll:el.scrollWidth, text:el.textContent})')
                assert dimensions['text'] == text, 'Decoration must preserve exact source text'
                result = {'width': width, 'font': size, 'fixture': index, 'rowHeight': row['height'], 'pseudoLeaks': len(leaks), 'horizontalOverflow': dimensions['scroll'] - dimensions['width']}
                report['cases'].append(result)
                if leaks or result['horizontalOverflow'] > 1:
                    report['failures'].append(result)
                    if len(report['failures']) == 1:
                        page.screenshot(path=str(case / 'failure.png'))
                # Markers must not alter flow when toggled off.
                page.locator('.fixture').evaluate('el => el.classList.add("bmd-hide-whitespace")')
                assert page.locator('.bmd-row').bounding_box() == row
                assert space.evaluate('el => getComputedStyle(el).backgroundImage === "none" && getComputedStyle(el, "::after").content === "none"')
                page.locator('.fixture').evaluate('el => el.classList.remove("bmd-hide-whitespace")')
    page.screenshot(path=str(case / 'result.png'))
    browser.close()
report['status'] = 'failed' if report['failures'] else 'passed'
(case / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({'status': report['status'], 'cases': len(report['cases']), 'failures': report['failures'][:6], 'evidence': str(case)}, indent=2))
assert not report['failures'], 'Whitespace decoration escaped its source row'
