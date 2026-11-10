import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';
import { createRemoteJWKSet, jwtVerify } from 'jose';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI;
let client = new MongoClient(uri);

let eventsCollection = client.db('greenLondon').collection('events');
let reservationCollection = client.db('greenLondon').collection('reservation');
let connectPromise;

function resetMongoClient() {
  client = new MongoClient(uri);
  eventsCollection = client.db('greenLondon').collection('events');
  reservationCollection = client.db('greenLondon').collection('reservation');
}

async function ensureMongoConnection(req, res, next) {
  try {
    if (client.topology?.isDestroyed()) {
      resetMongoClient();
      connectPromise = undefined;
    }
    connectPromise ??= client.connect();
    await connectPromise;
    next();
  } catch (error) {
    connectPromise = undefined;
    resetMongoClient();
    console.error('mongodb request failed', error);
    res.status(503).json({ error: 'Database unavailable' });
  }
}

const authBaseUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3000';
const authJwks = createRemoteJWKSet(new URL('/api/auth/jwks', authBaseUrl));

async function run() {
  try {
    async function getUserFromToken(req) {
      try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
          return null;
        }
        const decoded = await jwtVerify(token, authJwks);
        return decoded.payload;
      }
      catch (error) {
        console.log('invalid token', error.message);
        return null;
      }
    }

    app.get('/', (req, res) => {
      res.send('server is running');
    });

    app.use(['/events', '/add_events', '/reservation'], ensureMongoConnection);

    app.post('/add_events', async (req, res) => {
      const user = await getUserFromToken(req);

      if (!user) {
        return res.status(401).json({ error: 'You must be logged in to add an event' });
      }

      const newEvent = {
        title: req.body.title,
        description: req.body.description,
        eventType: req.body.eventType,
        thumbnail: req.body.thumbnail,
        location: req.body.location,
        eventDate: req.body.eventDate,
        capacity: req.body.capacity,
        registeredCount: 0,
        creatorEmail: user.email,
        creatorName: user.name || '',
        createdAt: new Date()
      };

      const result = await eventsCollection.insertOne(newEvent);
      console.log('event added');
      res.send(result);
    });

    app.get('/events', async (req, res) => {
      const upcomingOnly = req.query.upcoming === '1';
      const query = upcomingOnly
        ? { eventDate: { $gte: new Date().toISOString().slice(0, 10) } }
        : {};

      if (req.query.creatorEmail) {
        const user = await getUserFromToken(req);
        if (!user?.email) {
          return res.status(401).json({ error: 'You must be logged in to manage events' });
        }
        query.creatorEmail = user.email;
      }

      const cursor = eventsCollection.find(query);
      if (upcomingOnly) {
        cursor.sort({ eventDate: 1 });
      }
      const allEvents = await cursor.toArray();
      res.send(allEvents);
    });

    app.get('/events/featured', async (req, res) => {
      const today = new Date().toISOString().slice(0, 10);
      const featuredEvents = await eventsCollection
        .find({ eventDate: { $gte: today } })
        .sort({ eventDate: 1 })
        .limit(6)
        .toArray();
      res.send(featuredEvents);
    });

    app.get('/events/:id', async (req, res) => {
      const id = req.params.id;
      const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
      res.send(event);
    });

    app.patch('/events/:id', async (req, res) => {
      const user = await getUserFromToken(req);

      if (!user) {
        return res.status(401).json({ error: 'You must be logged in to update an event' });
      }

      const id = req.params.id;
      const event = await eventsCollection.findOne({ _id: new ObjectId(id) });

      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      if (event.creatorEmail !== user.email) {
        return res.status(403).json({ error: 'You can only update events you created' });
      }

      const filter = { _id: new ObjectId(id) };
      const update = { $set: req.body };
      const result = await eventsCollection.updateOne(filter, update);
      console.log('event updated');
      res.send(result);
    });

    app.delete('/events/:id', async (req, res) => {
      const user = await getUserFromToken(req);

      if (!user) {
        return res.status(401).json({ error: 'You must be logged in to delete an event' });
      }

      const id = req.params.id;
      const event = await eventsCollection.findOne({ _id: new ObjectId(id) });

      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      if (event.creatorEmail !== user.email) {
        return res.status(403).json({ error: 'You can only delete events you created' });
      }

      const query = { _id: new ObjectId(id) };
      const result = await eventsCollection.deleteOne(query);
      console.log('event deleted');
      res.send(result);
    });

    app.post('/reservation', async (req, res) => {
      const user = await getUserFromToken(req);

      if (!user) {
        return res.status(401).json({ error: 'You must be logged in to join an event' });
      }

      const data = req.body;
      data.userEmail = user.email;
      data.userName = user.name || '';
      data.joinedAt = new Date();
      const result = await reservationCollection.insertOne(data);
      console.log('reservation done');
      res.send(result);
    });

    app.get('/reservation', async (req, res) => {
      const user = await getUserFromToken(req);

      if (!user?.email) {
        return res.status(401).json({ error: 'You must be logged in to view joined events' });
      }

      const reservations = await reservationCollection.find({
        $or: [{ userEmail: user.email }, { email: user.email }],
        eventId: { $exists: true, $ne: null }
      }).toArray();
      res.send(reservations);
    });
  }
  catch (error) {
    console.log(error);
  }
}

run();

// Vercel invokes the exported Express app as a serverless handler. Keep the
// local listener for running this service directly during development.
if (process.env.VERCEL !== '1') {
  app.listen(5050, () => {
    console.log('server is running on port 5050');
  });
}

export default app;
