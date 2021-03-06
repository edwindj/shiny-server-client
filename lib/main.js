"use strict";

const assert = require("assert");
const fixupUrl = require("./fixup-url");
const log = require("./log");
const token = require("./decorators/token");
const subapp = require("./subapp");
const extendSession = require("./decorators/extend-session");
const reconnect = require("./decorators/reconnect");
const disconnect = require("./decorators/disconnect");
const multiplex = require("./decorators/multiplex");
const workerId = require("./decorators/worker-id");
const sockjs = require("./sockjs");
const PromisedConnection = require("./promised-connection");
const ConnectionContext = require("./decorators/connection-context");
const ReconnectUI = require("./reconnect-ui");
const ui = require("./ui");
const ProtocolChooser = require("./protocol-chooser");

/*
Connection factories:
- SockJS (reconnect-aware)
- Subapp

Connection factory decorators:
- WorkerId maintainer (reconnect-aware)
- Token adder
- Reconnector (requires underlying connections to be reconnect-aware)
- MultiplexClient

SSOS config:
  Primary app:
    SockJS + Reconnector + MultiplexClient
  Subapp:
    Subapp

SSP/RSC config:
  Primary app:
    SockJS + WorkerId + Token + Reconnector + MultiplexClient
  Subapp:
    Subapp
*/

let reconnectUI = new ReconnectUI();

/**
 * options = {
 *   debugging: false,
 *   extendSession: false,
 *   fixupInternalLinks: false,
 *   reconnect: false,
 *   subappTag: false,
 *   token: false,
 *   workerId: false,
 *
 *   reconnectTimeout: 15000,
 *   connectErrorDelay: 500,
 *   disableProtocols: [],
 *   transportDebugging: false
 * }
 *
 */
function initSession(shiny, options, shinyServer) {
  ProtocolChooser.init(shinyServer, options.disableProtocols);

  if (subapp.isSubApp()) {
    shiny.createSocket = () => {
      return subapp.createSocket();
    };
  } else {
    // Not a subapp

    let factory = sockjs.createFactory(ProtocolChooser, options);
    if (options.workerId) {
      factory = workerId.decorate(factory, options);
    }
    if (options.token) {
      factory = token.decorate(factory, options);
    }
    if (options.reconnect) {
      factory = reconnect.decorate(factory, options);
    } else {
      factory = disconnect.decorate(factory, options);
    }
    if (options.extendSession) {
      factory = extendSession.decorate(factory, options);
    }
    factory = multiplex.decorate(factory, options);

    // Register the connection with Shiny.createSocket, etc.
    shiny.createSocket = () => {
      let url = location.protocol + "//" + location.host + location.pathname.replace(/\/[^\/]*$/, "");
      url += "/__sockjs__/";

      reconnectUI.hide();

      let ctx = new ConnectionContext();

      let doReconnectHandler = () => {
        ctx.emit("do-reconnect");
      };

      reconnectUI.on("do-reconnect", doReconnectHandler);
      if (reconnectUI.listenerCount("do-reconnect") > 1) {
        log("do-reconnect handlers are leaking!");
      }

      ctx.on("reconnect-schedule", delay => {
        reconnectUI.showCountdown(delay);
      });
      ctx.on("reconnect-attempt", () => {
        reconnectUI.showAttempting();
      });
      ctx.on("reconnect-success", () => {
        reconnectUI.hide();
      });

      let onDisconnected = () => {
        reconnectUI.removeListener("do-reconnect", doReconnectHandler);
        reconnectUI.showDisconnected();
      };
      ctx.on("reconnect-failure", onDisconnected);
      ctx.on("disconnect", onDisconnected);

      let pc = new PromisedConnection();

      factory(url, ctx, (err, conn) => {
        pc.resolve(err, conn);
      });

      assert(ctx.multiplexClient);
      shinyServer.multiplexer = ctx.multiplexClient;

      // Signal to Shiny 0.14 and above that a Shiny-level reconnection (i.e.
      // automatically starting a new session) is permitted.
      pc.allowReconnect = true;
      ctx.on("disconnect", e => {
        // e here is the websocket/SockJS close event.

        // Don't allow a Shiny-level reconnection (new session) if we close
        // cleanly; this is an indication that the server wanted us to close
        // and stay closed (e.g. session idle timeout).
        //
        // But in some cases, even a clean close should allow reconnect; these
        // are cases where the server couldn't service our existing session
        // but wouldn't mind us starting a new one. E.g.: robust id not found
        // or expired. The server indicates this by sending a close code in
        // the 47xx range.
        if (e.code && e.code >= 4700 && e.code < 4800) {
          pc.allowReconnect = true;
        } else {
          pc.allowReconnect = false;
        }
      });

      return pc;
    };
  }
}

global.preShinyInit = function(options) {
  if (options.fixupInternalLinks && !subapp.isSubApp()) {
    global.jQuery(() => {
      fixupInternalLinks();
    });
  }

  if (!global.Shiny) {
    // Don't do anything if this isn't even a Shiny URL
    return;
  }

  global.ShinyServer = global.ShinyServer || {};
  initSession(global.Shiny, options, global.ShinyServer);

  /*eslint-disable no-console*/
  global.Shiny.oncustommessage = function(message) {
    if (message.license) ui.onLicense(global.Shiny, message.license);
    if (message.credentials) ui.onLoggedIn(message.credentials);

    if (typeof message === "string" && console.log) console.log(message); // Legacy format
    if (message.alert && console.log) console.log(message.alert);
    if (message.console && console.log) console.log(message.console);
  };
  /*eslint-enable no-console*/
};

global.fixupInternalLinks = fixupInternalLinks;
function fixupInternalLinks() {
  global.jQuery("body").on("click", "a", function(ev) {
    // We don't scrub links from subapps because a.) We need to make sure that
    // everything (even relative links) stick to the same worker, as this app
    // doesn't exist on another worker, and b.) because we don't care about the
    // side-effect of creating a big mess in the URL bar, since it's just an
    // iframe and won't be visible anyway.
    assert(!subapp.isSubApp());

    // setting /any/ value to ev.target.href (even assigning it to itself) would
    // have the side-effect of creating a real value in that property, even if
    // one shouldn't exist
    if (ev.currentTarget.href === null || !ev.currentTarget.href){
      return;
    }

    let href = fixupUrl(ev.currentTarget.href, global.location);
    if (href === ev.currentTarget.href) {
      // Must not have been a relative URL, or base href isn't in effect.
      return;
    }
    ev.currentTarget.href = href;
  });

}
