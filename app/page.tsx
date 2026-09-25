import { RelationshipMap } from "./relationship-map";
import packageJson from "../package.json";

export default function Home() {
  return <RelationshipMap appVersion={packageJson.version} />;
}
