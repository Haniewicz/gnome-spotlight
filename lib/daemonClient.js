// D-Bus frontend for gnome-spotlightd (DESIGN §13).
//
// Non-PURE on purpose: this module owns Gio.DBus/Gio.Cancellable and is only
// imported by extension.js. All search-stream merging lives in the PURE
// lib/searchStream.js module.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const BUS_NAME = 'org.gnome.Spotlight';
export const OBJECT_PATH = '/org/gnome/Spotlight/Search';
export const SEARCH_INTERFACE = 'org.gnome.Spotlight.Search';

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const PROBE_TIMEOUT_MS = 200;
const DEFAULT_SEARCH_TIMEOUT_MS = 150;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 100;

const SEARCH_REPLY_TYPE = new GLib.VariantType('(aa{sv}s)');

function unpack(value) {
  if (value && typeof value.deep_unpack === 'function') {
    try {
      return value.deep_unpack();
    } catch {
      return value;
    }
  }
  if (value && typeof value.unpack === 'function') {
    try {
      return value.unpack();
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value))
    return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.floor(value)));
}

function parseStats(rawStats) {
  const value = unpack(rawStats);
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value;

  if (typeof value !== 'string' || value.trim() === '')
    return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseActions(rawActions) {
  const value = unpack(rawActions);
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value;

  if (typeof value !== 'string' || value.trim() === '')
    return undefined;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value, fallback = '') {
  const unpacked = unpack(value);
  if (unpacked === null || unpacked === undefined)
    return fallback;
  return String(unpacked);
}

/**
 * Convert one `a{sv}` result dict from the daemon into the SearchResult shape
 * used by the modal and the providers.
 *
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeDaemonResult(raw) {
  if (!raw || typeof raw !== 'object')
    return null;

  const dict = {};
  for (const [key, value] of Object.entries(raw))
    dict[key] = unpack(value);

  const providerId = stringValue(dict.provider, stringValue(dict.providerId, ''));
  const id = stringValue(dict.id, '');
  if (id === '' && providerId === '')
    return null;

  const title = stringValue(dict.name, stringValue(dict.title, id));
  const description = stringValue(dict.description, stringValue(dict.subtitle, ''));
  const path = stringValue(dict.path, '');
  const score = Number(dict.score);
  const actions = parseActions(dict.actions);

  const result = {
    id,
    providerId,
    title,
    subtitle: description,
    description,
    icon: stringValue(dict.icon, 'application-x-executable-symbolic'),
    kind: stringValue(dict.kind, ''),
    score: Number.isFinite(score) ? score : 0,
  };

  if (path !== '') {
    result.path = path;
    result.preview = {
      path,
      rows: [['Ścieżka', path]],
      description: title,
    };
  }
  if (actions)
    result.actions = actions;

  return result;
}

function normalizeResults(rawResults) {
  const values = unpack(rawResults);
  if (!Array.isArray(values))
    return [];

  const results = [];
  for (const value of values) {
    const result = normalizeDaemonResult(unpack(value));
    if (result)
      results.push(result);
  }
  return results;
}

/**
 * Small async D-Bus client for the Spotlight daemon.
 *
 * `probe()` never rejects. `search()` invalidates the previous request via a
 * token + Gio.Cancellable and always resolves to `{results, stats, source}`
 * where `source` is one of `daemon`, `timeout`, `cancelled` or `error`.
 */
export class DaemonClient {
  constructor(options = {}) {
    let connection = options.connection;
    if (connection === undefined) {
      try {
        connection = Gio.DBus.session;
      } catch {
        connection = null;
      }
    }
    this._connection = connection ?? null;
    this._available = false;
    this._availabilityHandler = typeof options.onAvailabilityChanged === 'function'
      ? options.onAvailabilityChanged
      : null;
    this._token = 0;
    this._cancellable = null;
    this._finishCurrent = null;
    this._ownerChangedId = 0;
    this._disposed = false;

    this._subscribe();
  }

  get available() {
    return this._available;
  }

  setAvailabilityHandler(handler) {
    this._availabilityHandler = typeof handler === 'function' ? handler : null;
    return this;
  }

  _subscribe() {
    if (!this._connection)
      return;

    try {
      this._ownerChangedId = this._connection.signal_subscribe(
        DBUS_NAME,
        DBUS_INTERFACE,
        'NameOwnerChanged',
        DBUS_PATH,
        BUS_NAME,
        Gio.DBusSignalFlags.NONE,
        (_connection, _sender, _path, _iface, _signal, parameters) => {
          if (this._disposed)
            return;

          let owner = '';
          try {
            const [name, _oldOwner, newOwner] = parameters.deep_unpack();
            if (String(name) === BUS_NAME)
              owner = String(newOwner ?? '');
          } catch {
            return;
          }

          this._setAvailable(owner !== '');
        }
      );
    } catch {
      this._ownerChangedId = 0;
    }
  }

  _setAvailable(value) {
    const available = Boolean(value);
    if (available === this._available)
      return;

    this._available = available;
    try {
      this._availabilityHandler?.(available);
    } catch {
      // A consumer callback must never break the client.
    }
  }

  /**
   * Ask the session bus whether org.gnome.Spotlight currently has an owner.
   * The probe is bounded to 200 ms and never throws.
   *
   * @returns {Promise<boolean>}
   */
  probe() {
    if (this._disposed || !this._connection)
      return Promise.resolve(false);

    return new Promise(resolve => {
      let settled = false;
      let timer = 0;
      let cancellable = null;

      const finish = value => {
        if (settled)
          return;
        settled = true;

        if (timer) {
          try {
            GLib.source_remove(timer);
          } catch {
            // The timeout source already fired.
          }
          timer = 0;
        }

        this._setAvailable(value);
        resolve(value);
      };

      timer = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        PROBE_TIMEOUT_MS,
        () => {
          timer = 0;
          try {
            cancellable?.cancel();
          } catch {
            // Cancellation is best effort.
          }
          finish(false);
          return GLib.SOURCE_REMOVE;
        }
      );

      try {
        cancellable = new Gio.Cancellable();
        this._connection.call(
          DBUS_NAME,
          DBUS_PATH,
          DBUS_INTERFACE,
          'NameHasOwner',
          new GLib.Variant('(s)', [BUS_NAME]),
          new GLib.VariantType('(b)'),
          Gio.DBusCallFlags.NONE,
          PROBE_TIMEOUT_MS,
          cancellable,
          (connection, result) => {
            let owned = false;
            try {
              const reply = connection.call_finish(result);
              owned = Boolean(reply.deep_unpack()[0]);
            } catch {
              owned = false;
            }
            finish(owned);
          }
        );
      } catch {
        finish(false);
      }
    });
  }

  _cancelCurrent() {
    const finish = this._finishCurrent;
    this._finishCurrent = null;

    const cancellable = this._cancellable;
    this._cancellable = null;
    if (cancellable) {
      try {
        cancellable.cancel();
      } catch {
        // Already cancelled or finalized.
      }
    }

    if (finish) {
      try {
        finish({ results: [], stats: {}, source: 'cancelled' });
      } catch {
        // The request already settled.
      }
    }
  }

  /**
   * Search through the daemon.
   *
   * @param {string} query
   * @param {{mode?: string, limit?: number, timeoutMs?: number}} [options]
   * @returns {Promise<{results: object[], stats: object, source: string}>}
   */
  search(query, options = {}) {
    const mode = String(options?.mode ?? '');
    const limit = normalizeLimit(options?.limit);
    const timeoutValue = Number(options?.timeoutMs);
    const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0
      ? Math.floor(timeoutValue)
      : DEFAULT_SEARCH_TIMEOUT_MS;

    // A new search owns the modal: invalidate the previous token/call first.
    this._cancelCurrent();
    const token = ++this._token;

    if (this._disposed || !this._connection) {
      return Promise.resolve({ results: [], stats: {}, source: 'error' });
    }

    return new Promise(resolve => {
      const cancellable = new Gio.Cancellable();
      let settled = false;
      let timer = 0;
      let timedOut = false;

      const finish = payload => {
        if (settled || token !== this._token)
          return;
        settled = true;

        if (timer) {
          try {
            GLib.source_remove(timer);
          } catch {
            // The timeout source already fired.
          }
          timer = 0;
        }

        if (this._cancellable === cancellable)
          this._cancellable = null;
        if (this._finishCurrent === finish)
          this._finishCurrent = null;
        resolve(payload);
      };

      this._cancellable = cancellable;
      this._finishCurrent = finish;

      timer = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        timeoutMs,
        () => {
          timer = 0;
          timedOut = true;
          try {
            cancellable.cancel();
          } catch {
            // Cancellation is best effort.
          }
          finish({ results: [], stats: {}, source: 'timeout' });
          return GLib.SOURCE_REMOVE;
        }
      );

      try {
        this._connection.call(
          BUS_NAME,
          OBJECT_PATH,
          SEARCH_INTERFACE,
          'Search',
          new GLib.Variant('(ssi)', [String(query ?? ''), mode, limit]),
          SEARCH_REPLY_TYPE,
          Gio.DBusCallFlags.NONE,
          // Leave a little room so our own timer owns the "timeout" source
          // classification instead of racing the D-Bus timeout error.
          Math.max(1, timeoutMs + 50),
          cancellable,
          (connection, result) => {
            try {
              const reply = connection.call_finish(result);
              const [rawResults, rawStats] = reply.deep_unpack();
              finish({
                results: normalizeResults(rawResults),
                stats: parseStats(rawStats),
                source: 'daemon',
              });
            } catch {
              if (timedOut)
                finish({ results: [], stats: {}, source: 'timeout' });
              else
                finish({ results: [], stats: {}, source: 'error' });
            }
          }
        );
      } catch {
        finish({ results: [], stats: {}, source: 'error' });
      }
    });
  }

  dispose() {
    if (this._disposed)
      return;

    this._disposed = true;
    this._cancelCurrent();

    if (this._ownerChangedId && this._connection) {
      try {
        this._connection.signal_unsubscribe(this._ownerChangedId);
      } catch {
        // The connection may already be gone.
      }
      this._ownerChangedId = 0;
    }

    this._availabilityHandler = null;
    this._connection = null;
  }
}

export function createDaemonClient(options = {}) {
  return new DaemonClient(options);
}

// Module-level convenience client, mirroring the `probe()` / `search()`
// contract from DESIGN §13 for callers that do not need their own instance.
let sharedClient = null;

function shared() {
  if (!sharedClient)
    sharedClient = new DaemonClient();
  return sharedClient;
}

export function probe() {
  const client = shared();
  return client ? client.probe() : Promise.resolve(false);
}

export function search(query, options = {}) {
  const client = shared();
  return client
    ? client.search(query, options)
    : Promise.resolve({ results: [], stats: {}, source: 'error' });
}

export function dispose() {
  if (!sharedClient)
    return;
  sharedClient.dispose();
  sharedClient = null;
}

export default DaemonClient;