/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Pages starting with this URL are opened within the app, others in the system web browser (include any trailing slash!)
var LANDING_URL= "https://thequestionmark.github.io/cordova-web-wrap/";
// URLs listed here open in the app, others in the system web browser.
// Both absolute and host-relative URLs (with respect to LANDING_URL) are allowed.
// The URL on test includes a leading slash, but does not include query string or hash.
// Asterisks '*' act as a wildcard. Multiple entries are separated by a space.
// Note that it can be overridden by the document using the `data-app-local-urls` attribute.
var LOCAL_URLS = "/*";


// Regular expression for parsing full URLs, returning: base, path, query, hash.
var SPLIT_URL_RE = /^([^:/]+:\/\/[^/]+)(\/[^?]*)(?:\?([^#]*))?(?:#(.*))?$/i;
// Base URL for matching, derived from LANDING_URL (without trailing slash).
var BASE_URL     = LANDING_URL.match(SPLIT_URL_RE)[1];

// Main functionality using a state machine.
var Fsm = machina.Fsm.extend({

  initialState: "starting",

  appLastUrl: null,

  states: {

    // We're starting up (Cordova may not be ready yet).
    "starting": {
      _onEnter      : function() { this.onStarting(); },
      "deviceready" : "started",
    },

    // Setup everything and start loading the website.
    "started": {
      _onEnter       : function() { this.onStarted(); },
      "conn.offline" : "offline.blank",
    },

    // Load the page we want to show.
    "loading": {
      _onEnter         : function(e)     { this.onLoading(e); },
      "app.beforeload" : function(e, cb) { this.onNavigate(e, cb); },
      "app.loadstop"   : "loaded",
      "app.loaderror"  : "failed",
      "pause"          : "paused",
      "conn.offline"   : "offline.blank",
    },

    // Paused during page load.
    // Sometimes loading continues at this stage, so we need handlers for these events.
    "paused": {
      "resume"        : function()  { this.onResume(); },
      "app.loadstop"  : "loaded",
      "app.loaderror" : "failed",
      "conn.offline"  : "offline.blank",
    },

    // Page was succesfully loaded in the inAppBrowser.
    "loaded": {
      _onEnter         : function()      { this.onLoaded(); },
      "app.beforeload" : function(e, cb) { this.onNavigate(e, cb); },
      "app.exit"       : function()      { this.onBrowserBack(); }, // top of navigation and back pressed
      "conn.offline"   : "offline.loaded",
    },

    // Page load failed.
    "failed": {
      _onEnter       : function() { this.onFailed(); },
      "retry"        : function() { this.load(null, "loading"); },
      "conn.offline" : "offline.blank",
    },

    // Offline without a page loaded.
    "offline.blank": {
      _onEnter      : function() { this.onOfflineBlank(); },
      "conn.online" : function() { this.load(); },
    },

    // Offline and a page is loaded.
    "offline.loaded": {
      _onEnter      : function() { this.onOfflineLoaded(); },
      "conn.online" : "loaded",
    }
  },

  initialize: function() {
    this.setLocalUrls(LOCAL_URLS);
    // Log state transitions.
    this.on("*", function(event, data) {
      if (event === "transition" || event === "transitioned") {
        var action = data.action ? data.action.split(".").slice(1).join(".") : "(none)";
        debug(event + " from " + data.fromState + " to " + data.toState + " by " + action);
      } else if (event === "nohandler") {
        var transition = data.args[1].inputType; // may be a bit brittle
        debug("transition " + transition + " not handled");
      }
    });
  },

  onStarting: function() {
    document.addEventListener("deviceready", this.handle.bind(this, "deviceready"), false);
  },

  onStarted: function() {
    document.addEventListener("online",  wrapEventListener(this.handle.bind(this, "conn.online")), false);
    document.addEventListener("offline", wrapEventListener(this.handle.bind(this, "conn.offline")), false);
    // retry button (debounce 0.5s)
    document.getElementById("retry").addEventListener("click", _.debounce(this.handle.bind(this, "retry"), 500), false);
    // run handler on main thread (iOS) - https://cordova.apache.org/docs/en/latest/cordova/events/events.html#ios-quirks
    document.addEventListener("pause",   wrapEventListener(this.handle.bind(this, "pause")), false);
    document.addEventListener("resume",  wrapEventListener(this.handle.bind(this, "resume")), false);

    // query Google Play Services (see openScan)
    if (typeof(CheckInstalledServices) !== 'undefined') {
      CheckInstalledServices.check(
        function(msg) { this.hasPlayServices = msg.isGooglePlayServicesAvailable; }.bind(this),
        function(msg) { debug("openScan: CheckInstalledServices error: " + JSON.stringify(msg)); }
      );
    }

    // allow state transition to happen after this one
    setTimeout(function() {
      if (navigator.splashscreen) navigator.splashscreen.hide();
      this.load(LANDING_URL, "loading");
    }.bind(this), 0);
  },

  load: function(url, messageCode) {
    var _url = url || this.appLastUrl || LANDING_URL;

    this.appLastUrl = _url;

    this._load(_url);
    this.transition("loading", messageCode);
  },

  _load: function(url) {
    if (!this.app) {
      // When there is no inAppBrowser yet, open it.
      debug("load new: " + url);
      this.openBrowser(url);
    } else {
      // Otherwise keep the browser open and navigate to the new URL.
      debug("load existing: " + url);
      this.app.executeScript({ code: "window.location.assign(" + JSON.stringify(url) + ");" });
    }
  },

  onLoading: function(messageCode) {
    // if no code is given, it means: keep the same message as before (relevant for e.g. redirects)
    if (messageCode) this.showMessage(messageCode);
  },

  onLoaded: function(e) {
    // Allow LOCAL_URLS to be set by the page.
    this.app.executeScript({ code:
      '(function () {\n' +
      '  var el = document.querySelector("[data-app-local-urls]");\n' +
      '  if (el) return el.getAttribute("data-app-local-urls");\n' +
      '})();'
    }, function(localUrls) {
      if (localUrls && localUrls[0]) this.setLocalUrls(localUrls[0]);
    }.bind(this));
    // Show the page.
    this.showMessage(null);
    this.app.show();
  },

  onNavigate: function(e, cb) {
    if (e.url.match(/^app:\/\/mobile-scan\b/)) {
      // barcode scanner opened
      var params = parseQueryString(e.url) || {};
      this.openScan(params.ret, !!params.redirect);
    } else if (this.isLocalUrl(e.url)) {
      // don't interfere with local urls
      debug("internal link: " + e.url);
      this.appLastUrl = e.url;
      cb(e.url);
    } else {
      // all other links are opened in the system web browser
      this.openSystemBrowser(e.url);
    }
  },

  onBrowserBack: function() {
    debug("final back pressed, closing app");
    navigator.app.exitApp();
  },

  onResume: function() {
    this.load();
  },

  onFailed: function() {
    this.showMessage("failed");
  },

  onOfflineBlank: function() {
    this.showMessage("offline");
  },

  onOfflineLoaded: function() {
    this.showMessage("offline");
  },

  openBrowser: function(url) {
    var _url = url || this.appLastUrl || LANDING_URL;
    this.app = cordova.InAppBrowser.open(_url, "_blank", "location=no,zoom=no,shouldPauseOnSuspend=yes,toolbar=no,hidden=yes,beforeload=get");
    // Connect state-machine to inAppBrowser events.
    this.app.addEventListener("loadstart",    wrapEventListener(this.handle.bind(this, "app.loadstart")), false);
    this.app.addEventListener("loadstop",     wrapEventListener(this.handle.bind(this, "app.loadstop")), false);
    this.app.addEventListener("loaderror",    wrapEventListener(function(e) {
      if (window.cordova.platformId === 'ios' && e.code === -999) {
        debug("ignoring cancelled load on iOS: " + e.url + ": " + e.message);
      } if (window.cordova.platformId === 'ios' && e.code === 102) {
        // After a redirect from the server, iOS gives this error.
        // Downside: perhaps when a page load is interrupted, we might also see this.
        // After scanning a barcode one may redirect, so we favour that use-case here.
        // (hopefully this can be removed after inAppBrowser switched to WKWebView)
        debug("ignoring interrupted frameload on iOS (to allow redirect): " + e.url + ": " + e.message);
      } else {
        debug("page load failed for " + e.url + ": " + e.message);
        this.handle("app.loaderror", e);
      }
    }.bind(this)), false);
    this.app.addEventListener("beforeload",   wrapEventListener(this.handle.bind(this, "app.beforeload")), false);
    this.app.addEventListener("exit",         wrapEventListener(this.handle.bind(this, "app.exit")), false);
  },

  openSystemBrowser: function(url) {
    var launcher = window.plugins.launcher;
    // Need FLAG_ACTIVITY_NEW_TASK on Android 6 to make it clear that the page is
    // opened in another app. Also, the back button doesn't bring you back from
    // the system web browser to this app on Android 6, with this flag it does.
    launcher.launch({uri: url, flags: launcher.FLAG_ACTIVITY_NEW_TASK}, function(data) {
      if (data.isLaunched) {
        debug("successfully opened external link: " + url);
      } else if (data.isActivityDone) {
        debug("returned from opening external link: " + url);
      } else {
        debug("unknown response when opening external link: " + JSON.stringify(data));
      }
    }, function(errMsg) {
      debug("could not open external link: " + errMsg);
    });
  },

  openScan: function(returnUrlTemplate) {
    // First detect what scanner we may use.
    //   GMV = Google Mobile Vision barcode scanner
    //   BS  = Standard Cordova barcode scanner
    // We prefer GMV, but that requires Google Play Services on Android (on iOS,
    // the required code seems to be bundled with the app). To keep apps working
    // without (please support privacy-aware Android installations!), we use GMV
    // when Google Play Services are available, but fallback to BS if not.
    // (Unless you only included either GMV or BS, then this is always shown.)
    var hasGMV = typeof(CDV) !== 'undefined';
    var useGMV = hasGMV;
    var hasBS = typeof(cordova.plugins.barcodeScanner) !== 'undefined';
    var useBS = hasBS;

    debug("openScan: hasGMV=" + hasGMV.toString() + ", hasBS=" + hasBS.toString());

    if (window.cordova.platformId === 'android' && hasGMV && hasBS) {
      // It doesn't make sense to have GMV and BS without the check.
      if (typeof(this.hasPlayServices) === 'undefined') {
        debug("openScan: could not detect whether Google Play Services is present, "
              + "please make sure cordova-plugin-check-installed-services is installed!");
      }

      if (this.hasPlayServices) {
        debug("openScan: Google Play Services found, using GMV");
      } else {
        debug("openScan: Google Play Services not found, not using GMV");
        useGMV = false;
      }
    }

    // Prefer Google Mobile Vision barcode scanner. But GMV only works when Google
    // Play Services are installed (otherwise it will show a warning). So when both
    // GMV and BS are installed, require that the CheckInstalledServices plugin is
    // available
    if (useGMV) {
      debug("openScan[GMV]: " + returnUrlTemplate);
      CDV.scanner.scan({UPCA: true, UPCE: true, EAN8: true, EAN13: true}, function(err, result) {
        if (err && err.cancelled) {
          this.scanCancelled();
        } else if (err) {
          this.scanFailed(err.message);
        } else if (result) {
          debug("scan result: " + result);
          this.openScanUrl(returnUrlTemplate, result);
        } else {
          this.scanFailed("unknown reason");
        }
      }.bind(this));

    // else try Cordova Barcode scanner
    } else if (useBS) {
      debug("openScan[barcodeScanner]: " + returnUrlTemplate);
      cordova.plugins.barcodeScanner.scan(
        function(result) {
          if (result.cancelled) {
            this.scanCancelled();
          } else {
            debug("scan result: " + result.text);
            this.openScanUrl(returnUrlTemplate, result.text);
          }
        }.bind(this),
        function(error) {
          this.scanFailed(error);
        }.bind(this),
        {
          saveHistory: true,
          resultDisplayDuration: 500,
          formats: "UPC_A,UPC_E,EAN_8,EAN_13",
          disableSuccessBeep: true
        }
      );
    } else {
      debug("openScan: no scanner plugin available");
      alert("scan failed: no scanner plugin available");
      return false;
    }
    // necessary on iOS, see https://github.com/phonegap/phonegap-plugin-barcodescanner/issues/570
    if (window.cordova.platformId === 'ios') this.showMessage("scanning");
  },

  scanCancelled: function() {
    debug("scan cancelled");
    // necessary on iOS, see above
    if (window.cordova.platformId === 'ios') this.showMessage(null);
  },

  scanFailed: function(err) {
    debug("scan failed: " + error);
    alert("Scan failed: " + error);
    // necessary on iOS, see above
    if (window.cordova.platformId === 'ios') this.showMessage(null);
  },

  openScanUrl: function(returnUrlTemplate, barcode) {
    if (!returnUrlTemplate) {
      debug("scan: missing query parameter for the return url, please in include 'ret'");
      alert("Scan failed (return url missing)");
      return false;
    }
    if (!returnUrlTemplate.includes('{CODE}')) {
      debug("scan: {CODE} missing in the return parameter")
      alert("Scan failed (code missing in return url)");
      return false;
    }
    // Be a bit safer and only keep numbers (XSS risk).
    var safeBarcode = barcode.replace(/[^\d]/g, '');
    var url = returnUrlTemplate.replace('{CODE}', safeBarcode);
    setTimeout(function() {
      this.load(url, "finding");
    }.bind(this), 0);
    return true;
  },

  // Show message.
  showMessage: function(code) {
    debug("showMessage: " + code);
    if (this.app && !code) this.app.show();
    document.getElementById("event-starting").style.display = code === "starting" ? "block" : "none";
    document.getElementById("event-offline" ).style.display = code === "offline"  ? "block" : "none";
    document.getElementById("event-loading" ).style.display = code === "loading"  ? "block" : "none";
    document.getElementById("event-scanning").style.display = code === "scanning" ? "block" : "none";
    document.getElementById("event-finding" ).style.display = code === "finding"  ? "block" : "none";
    document.getElementById("event-failure" ).style.display = code === "failed"   ? "block" : "none";
    if (this.app && code) this.app.hide();
  },

  // Update local URLs and the regular expression for testing them.
  setLocalUrls: function(urls) {
    debug("setLocalUrls: " + urls);
    this.localUrls = urls;
    this.localUrlRe = new RegExp('^(' + urls.trim().split(/\s+/).map(function(s) {
      return s.replace(/([.*+?^${}()|\[\]\/\\])/g, '\\$1').replace('\\*', '.*');
    }).join('|') + ')$');
  },

  isLocalUrl: function(url) {
    var parts = url.match(SPLIT_URL_RE);
    if (parts) {
      var base = parts[1], path = parts[2];
      return (base + path).match(this.localUrlRe) || (base === BASE_URL && path.match(this.localUrlRe));
    }
  }
});
var fsm = new Fsm();
