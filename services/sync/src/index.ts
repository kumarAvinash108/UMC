import { start } from "./app.js";

const port = parseInt(process.env.PORT ?? "3000", 10);
start(port);
