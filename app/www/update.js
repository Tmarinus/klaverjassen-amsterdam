/* Auto-update for the sideloaded Android app.
 *
 * On launch (and when the app returns to the foreground), if we're running as the native
 * app and online, ask the native Updater plugin for the installed versionCode, fetch the
 * published version.json from the latest GitHub Release, and if a newer build exists,
 * download the APK and launch the system installer.
 *
 * Everything is a no-op in a normal browser (Pages / `npm run serve`): there is no native
 * Updater plugin and nothing to install, so `Capacitor.isNativePlatform()` short-circuits it.
 *
 * The URLs below use GitHub's stable `releases/latest/download/<asset>` redirect, so they
 * always point at the newest release without hard-coding a tag.
 */
(function () {
  var REPO = 'https://github.com/Tmarinus/klaverjassen-amsterdam';
  var VERSION_URL = REPO + '/releases/latest/download/version.json';
  var APK_URL = REPO + '/releases/latest/download/klaverjassen.apk';
  var THROTTLE_MS = 5 * 60 * 1000;   // don't re-check more than once per 5 min per foreground

  var inFlight = false;
  var lastCheck = 0;

  function nativeUpdater() {
    var C = window.Capacitor;
    if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return null;
    return (C.Plugins && C.Plugins.Updater) || null;
  }

  async function check() {
    var U = nativeUpdater();
    if (!U) return;                                   // browser / Pages build: nothing to do
    if (navigator.onLine === false) return;           // offline: try again next foreground
    if (inFlight) return;
    var now = Date.now();
    if (now - lastCheck < THROTTLE_MS) return;
    inFlight = true;
    try {
      var cur = await U.getCurrentVersion();          // { code, name }
      var resp = await U.httpGet({ url: VERSION_URL });
      var info = JSON.parse((resp && resp.body) || '{}');
      var remote = Number(info.versionCode || 0);
      var local = Number(cur && cur.code || 0);
      lastCheck = Date.now();
      if (remote > local) {
        if (typeof window.toast === 'function') {
          window.toast('Updating to ' + (info.versionName || ('v' + remote)) + '…');
        }
        await U.downloadAndInstall({ url: APK_URL });  // system "Install?" prompt appears
      }
    } catch (e) {
      // Silent by design — transient network / just-granted install permission etc.
      // Do not advance lastCheck so the next foreground retries sooner.
      if (window.console) console.log('[update] ' + ((e && e.message) || e));
    } finally {
      inFlight = false;
    }
  }

  if (document.readyState !== 'loading') check();
  else document.addEventListener('DOMContentLoaded', check);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') check();
  });
})();
