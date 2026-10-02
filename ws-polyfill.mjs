// Node 22+ provides a native global WebSocket, which stops node-roon-api from
// polyfilling with the `ws` package. node-roon-api relies on ws-only APIs
// (.on('pong'), .ping(), .terminate()), so force the global to be `ws`.
import WebSocket from 'ws';

globalThis.WebSocket = WebSocket;
