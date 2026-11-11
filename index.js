import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 5000;

//middleware
app.use(express.json());
app.use(cors())

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-ez5nunr-shard-00-00.hpkuazb.mongodb.net:27017,ac-ez5nunr-shard-00-01.hpkuazb.mongodb.net:27017,ac-ez5nunr-shard-00-02.hpkuazb.mongodb.net:27017/?ssl=true&replicaSet=atlas-8l7sww-shard-0&authSource=admin`);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("hireloopdb");
const users = database.collection("user");
const jobs = database.collection("jobs");

app.get('/', (req, res) => {
  res.send('Hireloop server is running');
});

app.get('/users', async (req, res) => { 
     const cursor = users.find({});
     const result = await cursor.toArray();
     res.send(result);
})

//jobs api


app.get('/jobs', async (req, res) => {
 
  const query = {}
if(req.query){
  if(req.query.jobType){
    query.type = req.query.jobType
  }
  if(req.query.remote){
    query.remote = req.query.remote === 'true';
  }
if(req.query.category){
  query.category = req.query.category;
}

   if (req.query.search) {
    query.$or = [
      { title: { $regex: req.query.search, $options: 'i' } },
      { responsibilities: { $regex: req.query.search, $options: 'i' } },
      { company: { $regex: req.query.search, $options: 'i' } },
      { requirements: { $regex: req.query.search, $options: 'i' } },
    ];
  }
}

  const cursor = jobs.find(query);
  const result = await cursor.toArray();
  res.send(result);
});


app.get('/jobs/:id', async (req, res) => {
  const id = req.params.id;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: 'Invalid job ID' });
  }

  const query = { _id: new ObjectId(id) };
  const result = await jobs.findOne(query);

  if (!result) {
    return res.status(404).send({ message: 'Job not found' });
  }

  res.send(result);
});



app.post('/jobs', async (req, res) => {
  const job = {
    ...req.body,
    applicants: 0,
    datePosted: new Date().toISOString(),
  };

  const result = await jobs.insertOne(job);
  res.send(result);
});

app.put('/jobs/:id', async (req, res) => {
  const id = req.params.id;
  const updatedJob = req.body;

  const query = { _id: new ObjectId(id) };

  const result = await jobs.updateOne(query, {
    $set: updatedJob,
  });

  res.send(result);
});


app.delete('/jobs/:id', async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await jobs.deleteOne(query);
  res.send(result);
});


app.listen(port, () => {
  console.log(`hire loop is running on port ${port}`);
});
