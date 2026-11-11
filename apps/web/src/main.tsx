import { render } from "preact";
import "@fontsource-variable/atkinson-hyperlegible-next/wght.css";
import { App } from "./App.tsx";
import "./styles.css";

render(<App />, document.getElementById("app")!);
