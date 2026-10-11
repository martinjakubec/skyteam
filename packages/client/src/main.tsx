import React from "react";
import ReactDOM from "react-dom/client";
import { Root } from "./Root";
import { resumeRoom } from "./pwa/installed";
import "./styles.css";
import "./theme-modern.css";

// The installed app, launched at "/": back into the room it was in.
resumeRoom();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
