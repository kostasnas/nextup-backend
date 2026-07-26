// instrument.js
// Must be required as the very first line of server.js, before any
// other imports — this is how Sentry's Node SDK is able to
// automatically instrument things like Express and catch errors.
const Sentry = require("@sentry/node");

Sentry.init({
  dsn: "https://59364d52c1923a15ca3cacd31c7cb296@o4511802576994304.ingest.de.sentry.io/4511802601766992",
});
