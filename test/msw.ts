import { setupServer } from "msw/node";

export const server = setupServer();

// request no handler answered; the setup file fails the test on any entry
export const leaks: string[] = [];

server.events.on("request:unhandled", ({ request }) => {
  leaks.push(`unhandled ${request.method} ${request.url}`);
});
server.events.on("response:bypass", ({ request }) => {
  leaks.push(`real network ${request.method} ${request.url}`);
});
server.events.on("unhandledException", ({ request, error }) => {
  leaks.push(`handler threw on ${request.method} ${request.url}: ${error}`);
});
