# Attributions

Presentation Converter is built on other people's work. This file lists what that work is, who did
it, and what it is doing here.

It is generated — the master lists live in the `stoatworks-backend` repo and are
pushed out by `scripts/sync-attributions.py`. Edit it there, not here.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### React

<https://react.dev>  
Licence: MIT  
Copyright: Meta Platforms, Inc. and affiliates

An npm dependency.

The UI layer for the browser tools and the Electron and Tauri front ends.

### pdf-lib

<https://github.com/Hopding/pdf-lib>  
Licence: MIT  
Copyright: Andrew Dillon

An npm dependency, bundled into the page. Where fonts are embedded, so is @pdf-lib/fontkit, the same author's MIT fork of fontkit.

Writes and edits PDF files in plain JavaScript, with no native library and no PDF engine behind it.

### fflate

<https://github.com/101arrowz/fflate>  
Licence: MIT  
Copyright: Arjun Barrett

An npm dependency, bundled into the page.

Zip and deflate in plain JavaScript, fast enough to use in a browser. Office documents, OpenDocument files and most multi-file downloads are zip packages underneath.

### The npm ecosystem

<https://www.npmjs.com>  
Licence: predominantly MIT  
Copyright: the individual package authors

npm dependencies, resolved and pinned in the lockfile.

Build tooling, test runners and the libraries the front ends are assembled from. The exact set and versions for any build are in that repo's lockfile, which is the authoritative list.

The full transitive dependency set for any build is pinned in this repo's lockfile,
which is the authoritative list. What is named above is the layers a reader would
want to know about, not every package that has ever been resolved.

## Getting this wrong

If your work is here and the description is inaccurate, the licence is wrong, or you would rather not be listed — open an issue and it will be fixed.
