import { readFileSync } from "fs";
import { MongoClient } from "mongodb";
import "dotenv/config";

const events = JSON.parse(readFileSync("./fakeData.json", "utf-8"));

const client = new MongoClient(process.env.MONGO_URI);

await client.connect();

try {
  await client.db("greenLondon").collection("events").deleteMany({});
  const result = await client
    .db("greenLondon")
    .collection("events")
    .insertMany(events);
  console.log(`Seeded ${result.insertedCount} events.`);
} finally {
  await client.close();
}
