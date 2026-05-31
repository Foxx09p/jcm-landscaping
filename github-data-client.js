(function () {
  "use strict";

  var SESSION_KEY = "jcmSessionToken";
  var API_BASE = window.JCM_API_BASE_URL ||
    (/^https?:$/.test(window.location.protocol) ? "" : "https://jcm-landscaping.com");
  var memoryStorage = {};
  var browserStorage = (function () {
    try {
      if (window.localStorage) return window.localStorage;
    } catch (error) {
      // Some embedded browsers disable persistent storage.
    }
    return {
      getItem: function (key) { return memoryStorage[key] || null; },
      setItem: function (key, value) { memoryStorage[key] = String(value); },
      removeItem: function (key) { delete memoryStorage[key]; }
    };
  })();
  var sessionToken = browserStorage.getItem(SESSION_KEY) || "";

  function randomId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "jcm-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function apiUrl(path) {
    return API_BASE + path;
  }

  async function apiRequest(path, options) {
    var request = Object.assign({}, options || {});
    request.headers = Object.assign({}, request.headers || {});
    if (sessionToken) request.headers.Authorization = "Bearer " + sessionToken;
    if (request.body && typeof request.body !== "string" && !(request.body instanceof Blob) && !(request.body instanceof ArrayBuffer)) {
      request.headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(request.body);
    }
    var response = await fetch(apiUrl(path), request);
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var error = new Error(data.error || "Request failed.");
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }

  function ClientTimestamp(value) {
    this.value = value;
    this.seconds = Math.floor(new Date(value).getTime() / 1000);
  }
  ClientTimestamp.prototype.toDate = function () {
    return new Date(this.value);
  };
  ClientTimestamp.prototype.toJSON = function () {
    return { __jcmTimestamp: this.value };
  };

  function hydrate(value) {
    if (Array.isArray(value)) return value.map(hydrate);
    if (!value || typeof value !== "object") return value;
    if (value.__jcmTimestamp) return new ClientTimestamp(value.__jcmTimestamp);
    return Object.fromEntries(Object.entries(value).map(function (entry) {
      return [entry[0], hydrate(entry[1])];
    }));
  }

  function serverTimestamp() {
    return { __jcmServerTimestamp: true };
  }

  function Snapshot(ref, record) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = Boolean(record);
    this._data = record ? hydrate(record.data) : undefined;
  }
  Snapshot.prototype.data = function () {
    return this._data;
  };

  function QuerySnapshot(records, database) {
    this.docs = (records || []).map(function (record) {
      return new Snapshot(new DocumentReference(database, record.path), record);
    });
    this.empty = this.docs.length === 0;
    this.size = this.docs.length;
  }

  function store(action, payload) {
    return apiRequest("/api/data/store", {
      method: "POST",
      body: Object.assign({ action: action }, payload || {})
    });
  }

  function poll(load, success, failure) {
    var active = true;
    var running = false;
    async function refresh() {
      if (!active || running) return;
      running = true;
      try {
        success(await load());
      } catch (error) {
        if (failure) failure(error);
      } finally {
        running = false;
      }
    }
    refresh();
    var timer = window.setInterval(refresh, 30000);
    return function () {
      active = false;
      window.clearInterval(timer);
    };
  }

  function DocumentReference(database, path) {
    this.database = database;
    this.path = String(path).replace(/^\/+|\/+$/g, "");
    this.id = this.path.split("/").pop();
  }
  DocumentReference.prototype.collection = function (name) {
    return new CollectionReference(this.database, this.path + "/" + name);
  };
  DocumentReference.prototype.get = async function () {
    var data = await store("get", { path: this.path });
    return new Snapshot(this, data.result);
  };
  DocumentReference.prototype.set = function (data, options) {
    return store("commit", {
      operations: [{ type: "set", path: this.path, data: data, merge: Boolean(options && options.merge) }]
    });
  };
  DocumentReference.prototype.update = function (data) {
    return store("commit", { operations: [{ type: "update", path: this.path, data: data }] });
  };
  DocumentReference.prototype.onSnapshot = function (success, failure) {
    var self = this;
    return poll(function () { return self.get(); }, success, failure);
  };

  function QueryReference(database, path, query) {
    this.database = database;
    this.path = String(path).replace(/^\/+|\/+$/g, "");
    this.query = query || { filters: [] };
  }
  QueryReference.prototype.where = function (field, op, value) {
    return new QueryReference(this.database, this.path, Object.assign({}, this.query, {
      filters: (this.query.filters || []).concat([{ field: field, op: op, value: value }])
    }));
  };
  QueryReference.prototype.orderBy = function (field, direction) {
    return new QueryReference(this.database, this.path, Object.assign({}, this.query, {
      orderBy: field,
      orderDirection: direction || "asc"
    }));
  };
  QueryReference.prototype.limit = function (maximum) {
    return new QueryReference(this.database, this.path, Object.assign({}, this.query, { limit: maximum }));
  };
  QueryReference.prototype.get = async function () {
    var data = await store("list", { path: this.path, query: this.query });
    return new QuerySnapshot(data.result, this.database);
  };
  QueryReference.prototype.onSnapshot = function (success, failure) {
    var self = this;
    return poll(function () { return self.get(); }, success, failure);
  };

  function CollectionReference(database, path) {
    QueryReference.call(this, database, path, { filters: [] });
  }
  CollectionReference.prototype = Object.create(QueryReference.prototype);
  CollectionReference.prototype.constructor = CollectionReference;
  CollectionReference.prototype.doc = function (id) {
    return new DocumentReference(this.database, this.path + "/" + (id || randomId()));
  };

  function WriteBatch() {
    this.operations = [];
  }
  WriteBatch.prototype.set = function (ref, data, options) {
    this.operations.push({ type: "set", path: ref.path, data: data, merge: Boolean(options && options.merge) });
    return this;
  };
  WriteBatch.prototype.update = function (ref, data) {
    this.operations.push({ type: "update", path: ref.path, data: data });
    return this;
  };
  WriteBatch.prototype.commit = function () {
    return store("commit", { operations: this.operations });
  };

  function ClientTransaction() {
    this.operations = [];
  }
  ClientTransaction.prototype.get = function (ref) {
    return ref.get();
  };
  ClientTransaction.prototype.set = function (ref, data, options) {
    this.operations.push({ type: "set", path: ref.path, data: data, merge: Boolean(options && options.merge) });
    return this;
  };
  ClientTransaction.prototype.update = function (ref, data) {
    this.operations.push({ type: "update", path: ref.path, data: data });
    return this;
  };

  function GithubDatabase() {}
  GithubDatabase.prototype.settings = function () {};
  GithubDatabase.prototype.collection = function (path) {
    return new CollectionReference(this, path);
  };
  GithubDatabase.prototype.batch = function () {
    return new WriteBatch();
  };
  GithubDatabase.prototype.runTransaction = async function (callback) {
    var transaction = new ClientTransaction();
    var result = await callback(transaction);
    if (transaction.operations.length) await store("commit", { operations: transaction.operations });
    return result;
  };

  function AuthUser(profile) {
    Object.assign(this, profile || {});
    this.emailVerified = profile && profile.emailVerified !== false;
  }
  AuthUser.prototype.getIdToken = function () {
    return Promise.resolve(sessionToken);
  };
  AuthUser.prototype.updateProfile = async function (updates) {
    var data = await apiRequest("/api/auth/session", { method: "POST", body: updates || {} });
    Object.assign(this, data.user || {});
  };
  AuthUser.prototype.reload = async function () {
    var data = await apiRequest("/api/auth/session", { method: "GET" });
    Object.assign(this, data.user || {});
  };
  AuthUser.prototype.sendEmailVerification = function () {
    return Promise.resolve();
  };

  function GithubAuth() {
    this.currentUser = null;
    this.observers = [];
    this.initialized = false;
    this.restore();
  }
  GithubAuth.prototype.notify = function () {
    var user = this.currentUser;
    this.observers.slice().forEach(function (observer) { observer(user); });
  };
  GithubAuth.prototype.restore = async function () {
    if (sessionToken) {
      try {
        var data = await apiRequest("/api/auth/session", { method: "GET" });
        this.currentUser = new AuthUser(data.user);
      } catch (error) {
        sessionToken = "";
        browserStorage.removeItem(SESSION_KEY);
      }
    }
    this.initialized = true;
    this.notify();
  };
  GithubAuth.prototype.onAuthStateChanged = function (observer) {
    this.observers.push(observer);
    if (this.initialized) observer(this.currentUser);
    var self = this;
    return function () {
      self.observers = self.observers.filter(function (item) { return item !== observer; });
    };
  };
  GithubAuth.prototype.createUserWithEmailAndPassword = async function (email, password) {
    var nameField = document.getElementById("authName");
    var data = await apiRequest("/api/auth/register", {
      method: "POST",
      body: { email: email, password: password, displayName: nameField ? nameField.value.trim() : "" }
    });
    sessionToken = data.token;
    browserStorage.setItem(SESSION_KEY, sessionToken);
    this.currentUser = new AuthUser(data.user);
    this.notify();
    return { user: this.currentUser };
  };
  GithubAuth.prototype.signInWithEmailAndPassword = async function (email, password) {
    var data = await apiRequest("/api/auth/login", { method: "POST", body: { email: email, password: password } });
    sessionToken = data.token;
    browserStorage.setItem(SESSION_KEY, sessionToken);
    this.currentUser = new AuthUser(data.user);
    this.notify();
    return { user: this.currentUser };
  };
  GithubAuth.prototype.signOut = function () {
    sessionToken = "";
    browserStorage.removeItem(SESSION_KEY);
    this.currentUser = null;
    this.notify();
    return Promise.resolve();
  };
  GithubAuth.prototype.signInWithPopup = function () {
    return Promise.reject(new Error("Use email and password sign-in."));
  };
  GithubAuth.prototype.signInWithPhoneNumber = function () {
    return Promise.reject(new Error("Phone sign-in is unavailable until an SMS provider is configured."));
  };

  function RecaptchaVerifier() {}
  RecaptchaVerifier.prototype.clear = function () {};

  function StorageReference(path) {
    this.path = path;
  }
  StorageReference.prototype.put = async function (file) {
    var response = await fetch(apiUrl("/api/data/upload?path=" + encodeURIComponent(this.path)), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + sessionToken,
        "Content-Type": file.type || "application/octet-stream"
      },
      body: file
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || "Image upload failed.");
    return {
      ref: {
        getDownloadURL: function () { return Promise.resolve(data.url); }
      }
    };
  };

  function GithubStorage() {}
  GithubStorage.prototype.ref = function (path) {
    return new StorageReference(path);
  };

  var authInstance = new GithubAuth();
  var databaseInstance = new GithubDatabase();
  var storageInstance = new GithubStorage();

  function auth() { return authInstance; }
  auth.GoogleAuthProvider = function () {};
  auth.RecaptchaVerifier = RecaptchaVerifier;

  function database() { return databaseInstance; }
  database.FieldValue = { serverTimestamp: serverTimestamp };

  function storage() { return storageInstance; }

  window.githubData = {
    apiBase: API_BASE,
    auth: auth,
    database: database,
    storage: storage
  };

})();
