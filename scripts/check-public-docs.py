"""Validate maintained public entry points without network or package dependencies."""
from pathlib import Path
from urllib.parse import unquote, urlsplit
import os
import re
import sys

root = Path.cwd()
fallback = Path(os.environ.get('DOCS_FALLBACK_ROOT', root))
paths = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
         'profile/README.md', 'docs/getting-started.md', 'docs/sandbox.md',
         'docs/config.md', 'docs/contributing.md', 'docs/authentication.md', 'docs/exec.md']
errors = []
checked = 0
for name in paths:
    file = root / name
    if not file.is_file():
        continue
    text = file.read_text()
    checked += 1
    if not text.strip():
        errors.append(f'{name}: empty document')
    for image, label, target in re.findall(r'(!?)\[([^\]]*)\]\(([^)]+)\)', text):
        target = target.strip().split(' ')[0].strip('<>')
        url = urlsplit(target)
        if image and not label.strip():
            errors.append(f'{name}: image needs descriptive alt text')
        if url.scheme or url.netloc or not url.path:
            continue
        relative = (file.parent / unquote(url.path)).resolve()
        try:
            rel = relative.relative_to(root)
        except ValueError:
            errors.append(f'{name}: link escapes repository: {target}')
            continue
        if not relative.exists() and not (fallback / rel).exists():
            errors.append(f'{name}: missing local link: {target}')
    if re.search(r'\]\(https://github.com/ditfa-dev/ditfa-cli/blob/main/' + re.escape(name) + r'\)', text):
        errors.append(f'{name}: circular documentation link')
if errors:
    print('\n'.join(errors), file=sys.stderr)
    sys.exit(1)
print(f'Validated {checked} public documents: local links, image descriptions and circular references.')
