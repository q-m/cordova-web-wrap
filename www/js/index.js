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
      _onEnter        : function(e) { this.onLoading(e); },
      "app.loadstop"  : "loaded",
      "app.loaderror" : "failed",
      "pause"         : "paused",
      "conn.offline"  : "offline.blank",
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
      _onEnter        : function()  { this.onLoaded(); },
      "app.loadstart" : function(e) { this.onNavigate(e); },
      "app.exit"      : function()  { this.onBrowserBack(); }, // top of navigation and back pressed
      "conn.offline"  : "offline.loaded",
    },

    // Page load failed.
    "failed": {
      _onEnter       : function() { this.onFailed(); },
      "retry"        : function() { this.load(); },
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
    },
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
    document.addEventListener("online",  this.handle.bind(this, "conn.online"), false);
    document.addEventListener("offline", this.handle.bind(this, "conn.offline"), false);
    // retry button (debounce 0.5s)
    document.getElementById("retry").addEventListener("click", _.debounce(this.handle.bind(this, "retry"), 500), false);
    // run handler on main thread (iOS) - https://cordova.apache.org/docs/en/latest/cordova/events/events.html#ios-quirks
    document.addEventListener("pause",   function() { setTimeout(this.handle.bind(this, "pause" ), 0); }.bind(this), false);
    document.addEventListener("resume",  function() { setTimeout(this.handle.bind(this, "resume"), 0); }.bind(this), false);

    this.openBrowser();

    if (navigator.splashscreen) navigator.splashscreen.hide();
    this.load(LANDING_URL, "loading");
  },

  load: function(url, messageCode) {
    var _url = url || this.appLastUrl || LANDING_URL;

    this.appLastUrl = _url;

    // if no code is given, it means: keep the same message as before (relevant for e.g. redirects)
    if (messageCode) this.showMessage(messageCode);

    if (!this.app) {
      // When there is no inAppBrowser yet, open it.
      debug("load new: " + _url);
      this.openBrowser(_url);
    } else {
      // Otherwise keep the browser open and navigate to the new URL.
      debug("load existing: " + _url);
      this.app.executeScript({ code: "window.location.assign(" + JSON.stringify(_url) + ");" });
    }
    this.transition("loading", messageCode);
  },

  onLoading: function(messageCode) {
    // if no code is given, it means: keep the same message as before (relevant for e.g. redirects)
    if (messageCode) this.showMessage(messageCode);
  },

  onLoaded: function() {
    // Allow LOCAL_URLS to be set by the page.
    this.app.executeScript({ code:
      '(function () {\n' +
      '  var el = document.querySelector("[data-app-local-urls]");\n' +
      '  if (el) return el.getAttribute("data-app-local-urls");\n' +
      '})();'
    }, function(localUrls) {
      if (localUrls && localUrls[0]) this.setLocalUrls(localUrls[0]);
    }.bind(this));
    // Catch links that were clicked to route external ones through our custom protocol.
    // We'd rather not do this in the loadstart event, because the page then already started loading.
    this.app.executeScript({ code:
      'window.addEventListener("click", function(e) {\n' +
      '  if (e.target.tagName !== "A") return;\n' +
      '  var href = e.target.href;\n' +
      '  if (!href || href.startsWith("app:")) return;\n' +
      '  var BASE_URL     = ' + JSON.stringify(BASE_URL) + ';\n' +
      '  var SPLIT_URL_RE = ' + SPLIT_URL_RE.toString() + ';\n' +
      '  var localUrlRe   = ' + this.localUrlRe.toString() + ';\n' +
      '  var parts = href.match(SPLIT_URL_RE);\n' +
      '  var base = parts[1], path = parts[2];\n' +
      '  if (!(base + path).match(localUrlRe) && !(base === BASE_URL && path.match(localUrlRe))) {\n' +
      '    e.preventDefault();\n' +
      '    window.location.assign("app://open?url=" + encodeURIComponent(href));\n' +
      '  }\n' +
      '});\n' +
      'console.log("installed click event listener for external links");\n'
    });
    // Show the page.
    this.showMessage(null);
    this.app.show();
  },

  onNavigate: function(e) {
    var parts = e.url.match(SPLIT_URL_RE);
    var base = parts[1], path = parts[2];
    if ((base + path).match(this.localUrlRe) || (base === BASE_URL && path.match(this.localUrlRe))) {
      // Internal link followed.
      debug("opening internal link: " + e.url);
      this.appLastUrl = e.url;
      this.transition("loading", null);
    } else {
      // External link opened. Should be unreachable code because of the onLoaded() code injection,
      // but might happen if javascript opens a link (e.g. embedded Google Map).
      debug("opening external link (not caught on page): " + e.url);
      this.openSystemBrowser(e.url);
      // Cancel navigation of inAppBrowser. This is a bit of a hack, so the event listener
      // installed in onLoaded is preferable (which also avoids the initial request).
      this.app.executeScript({ code: 'window.location.replace(window.location);' });
    }
  },

  onCustomScheme: function(e) {
    debug("custom scheme: " + e.url);
    if (e.url.match(/^app:\/\/mobile-scan\b/)) {
      var params = parseQueryString(e.url) || {};
      this.openScan(params.ret, !!params.redirect);
    } else if (e.url.match(/^app:\/\/open\b/)) {
      var url = parseQueryString(e.url).url;
      debug("opening external link:" + url);
      this.openSystemBrowser(url);
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
    this.app = cordova.InAppBrowser.open(_url, "_blank", "location=no,zoom=no,shouldPauseOnSuspend=yes,toolbar=no,hidden=yes");
    // Get info from inAppBrowser events. No actions, just saving state and logging.
    this.app.addEventListener("loadstop",     function(e) { this.appLastUrl = e.url; }.bind(this), false);
    this.app.addEventListener("loaderror",    function(e) { debug("page load failed: " + e.message); }, false);
    // Connect state-machine to inAppBrowser events.
    this.app.addEventListener("loadstart",    this.handle.bind(this, "app.loadstart"), false);
    this.app.addEventListener("loadstop",     this.handle.bind(this, "app.loadstop"), false);
    this.app.addEventListener("loaderror",    this.handle.bind(this, "app.loaderror"), false);
    this.app.addEventListener("exit",         this.handle.bind(this, "app.exit"), false);
    this.app.addEventListener("customscheme", this.onCustomScheme.bind(this), false);
  },

  openSystemBrowser: function(url) {
    // Do not use InAppBrowser because it messes up opened inAppBrowser state.
    window.plugins.launcher.launch({uri: url}, function(data){
      debug("successfully opened external link");
    }, function(errMsg) {
      debug("could not open external link: " + errMsg);
    });
  },

  openScan: function(returnUrlTemplate) {
    debug("openScan: " + returnUrlTemplate);
    cordova.plugins.barcodeScanner.scan(
      function(result) {
        if (result.cancelled) {
          debug("scan cancelled");
          // necessary on iOS, see below
          if (window.cordova.platformId === 'ios') this.showMessage(null);
        } else {
          debug("scan result: " + result.text);
          this.openScanUrl(returnUrlTemplate, result.text);
        }
      }.bind(this),
      function(error) {
        debug("scan failed: " + error);
        alert("Scan failed: " + error);
      }.bind(this),
      {
        saveHistory: true,
        resultDisplayDuration: 500,
        formats: "UPC_A,UPC_E,EAN_8,EAN_13",
        disableSuccessBeep: true
      }
    );
    // necessary on iOS, see https://github.com/phonegap/phonegap-plugin-barcodescanner/issues/570
    if (window.cordova.platformId === 'ios') this.showMessage("scanning");
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
    this.load(url, "finding");
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
  }
});
var fsm = new Fsm();
