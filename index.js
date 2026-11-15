import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
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
const applications = database.collection("applications");
const savedJobs = database.collection("savedJobs");
const payments = database.collection("payments");


// Prevent duplicate saved jobs for the same user
await savedJobs.createIndex(
  { userId: 1, jobId: 1 },
  { unique: true }
);

app.get('/', (req, res) => {
  res.send('Hireloop server is running');
});

//users related apis
app.get('/users', async (req, res) => { 
     const cursor = users.find({});
     const result = await cursor.toArray();
     res.send(result);
})

app.get('/users/:id/premium', async (req, res) =>{
  const id = req.params.id;
  const query = {_id: new ObjectId(id)};
  const result = await users.findOne(query, {
    projection: {
    premium: 1,
    recruiterPremium: 1,
  },
});
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
if (req.query.userId) {
  query.userId = req.query.userId;
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

// Get total job posts by a specific recruiter
app.get('/jobs/count', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).send({
      message: 'User ID is required',
    });
  }

  const count = await jobs.countDocuments({ userId });

  res.send({ count });
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



// applications related apis


app.get('/applications', async (req, res) => {
  const query = {};
  if(req.query.applicantId){
    query.userId = req.query.applicantId;
  }
  if(req.query.jobId){
    query.jobId = req.query.jobId;
  }
  const result = await applications.find(query).toArray();
  res.send(result);
})

app.get('/applications/count', async (req, res) => {
  const query = {};
  if(req.query.applicantId){
    query.userId = req.query.applicantId;
  }
  const result = await applications.countDocuments(query)
  res.send({count: result});
})

app.post('/applications', async (req, res) => {
  const application = {
    ...req.body,
    isArchived: false,
  }

  const result = await applications.insertOne(application)
  res.send(result)
})

app.patch('/applications/:id', async (req, res) =>{
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const updateDoc = {
    $set: { 
      status: req.body.status,
    }
  }
  const result = await applications.updateOne(query, updateDoc)
  res.send(result)
})

// Archive / Unarchive an application
app.patch('/applications/:id/archive', async (req, res) => {
  const id = req.params.id
  const { isArchived } = req.body

  const query = { _id: new ObjectId(id) }
  const updateDoc = {
    $set: { isArchived },
  }

  const result = await applications.updateOne(query, updateDoc)

  res.send(result)
})



// saved jobs apis

// Get saved jobs for a specific user
app.get('/saved-jobs', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).send({
      message: 'User ID is required',
    });
  }

  const savedJobsList = await savedJobs
    .find({ userId })
    .sort({ savedAt: -1 })
    .toArray();

  const result = await Promise.all(
    savedJobsList.map(async (savedJob) => {
      if (!ObjectId.isValid(savedJob.jobId)) {
        return null;
      }

      const job = await jobs.findOne({
        _id: new ObjectId(savedJob.jobId),
      });

      if (!job) {
        return null;
      }

      return {
        ...savedJob,
        job,
      };
    })
  );

  return res.send(result.filter(Boolean));
});


// Save a job
app.post('/saved-jobs', async (req, res) => {
  const { userId, jobId } = req.body;

  if (!userId || !jobId) {
    return res.status(400).send({
      message: 'User ID and Job ID are required',
    });
  }

  if (!ObjectId.isValid(jobId)) {
    return res.status(400).send({
      message: 'Invalid Job ID',
    });
  }

  const job = await jobs.findOne({
    _id: new ObjectId(jobId),
  });

  if (!job) {
    return res.status(404).send({
      message: 'Job not found',
    });
  }

  const savedJob = {
    userId,
    jobId,
    savedAt: new Date(),
  };

  try {
    const result = await savedJobs.insertOne(savedJob);

    res.status(201).send({
      message: 'Job saved successfully',
      insertedId: result.insertedId,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).send({
        message: 'Job already saved',
      });
    }

    res.status(500).send({
      message: 'Failed to save job',
    });
  }
});


// Remove a saved job
app.delete('/saved-jobs/:id', async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({
      message: 'Invalid Saved Job ID',
    });
  }

  const result = await savedJobs.deleteOne({
    _id: new ObjectId(id),
  });

  if (result.deletedCount === 0) {
    return res.status(404).send({
      message: 'Saved job not found',
    });
  }

  res.send({
    message: 'Saved job removed successfully',
  });
});

//payments related apis


app.post('/payments/checkout-verify', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.send({
      success: false,
      message: 'Session ID is required',
    });
  }

  const {
    status,
    payment_status,
    customer_email,
    metadata,
    payment_intent,
  } = await stripe.checkout.sessions.retrieve(sessionId);

  if (status === 'complete' && payment_status === 'paid') {
    const sessionQuery = { sessionId };
    const existingPayment = await payments.findOne(sessionQuery);

    if (existingPayment) {
      return res.send({
        success: false,
        message: 'Payment already verified',
      });
    }

    const plan = metadata.plan || 'seeker';

    const payment = {
      sessionId,
      status,
      payment_status,
      customer_email,
      userId: metadata.userId,
      plan,
      payment_date: new Date(),
      payment_intent,
    };

    const result = await payments.insertOne(payment);

    const query = {
      _id: new ObjectId(metadata.userId),
    };

    const premiumField =
      plan === 'recruiter'
        ? 'recruiterPremium'
        : 'premium';

    const updateResult = await users.updateOne(query, {
      $set: {
        [premiumField]: true,
      },
    });

    res.send({
      success: true,
      result,
      updateResult,
    });

    return;
  }

  res.send({
    success: false,
    message: 'Payment verification failed',
  });
});



app.listen(port, () => {
  console.log(`hire loop is running on port ${port}`);
});
