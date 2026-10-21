// electron-builder afterPack hook: strip extended attributes (quarantine, provenance,
// and especially com.apple.FinderInfo on the bundle folders) from the packaged macOS
// app before it is signed. codesign rejects bundles carrying them ("resource fork,
// Finder information, or similar detritus not allowed"), and `xattr -c` alone does not
// always clear FinderInfo on bundle directories, so it is deleted explicitly too.
const { execFileSync, execSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('xattr', ['-cr', app]);
  execSync(`find ${JSON.stringify(app)} -exec xattr -d com.apple.FinderInfo {} + 2>/dev/null || true`);
};
