
import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(
  `mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-ez5nunr-shard-00-00.hpkuazb.mongodb.net:27017,ac-ez5nunr-shard-00-01.hpkuazb.mongodb.net:27017,ac-ez5nunr-shard-00-02.hpkuazb.mongodb.net:27017/?ssl=true&replicaSet=atlas-8l7sww-shard-0&authSource=admin`
);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('You successfully connected to MongoDB!');
    return client;
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    throw err;
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db('hireloopdb');

const users = database.collection('user');
const sessions = database.collection('session');
const jobs = database.collection('jobs');
const applications = database.collection('applications');
const savedJobs = database.collection('savedJobs');
const payments = database.collection('payments');

// Prevent duplicate saved jobs
await savedJobs.createIndex(
  { userId: 1, jobId: 1 },
  { unique: true }
);

// Home
app.get('/', (req, res) => {
  res.send('Hireloop server is running');
});

// ==============================
// AUTHENTICATION MIDDLEWARE
// ==============================

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).send({
        message: 'Unauthorized',
      });
    }

    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);

    if (!tokenMatch) {
      return res.status(401).send({
        message: 'Invalid authorization format',
      });
    }

    const token = tokenMatch[1];

    const session = await sessions.findOne({ token });

    if (!session) {
      return res.status(401).send({
        message: 'Invalid or expired session',
      });
    }

    if (
      session.expiresAt &&
      new Date(session.expiresAt).getTime() <= Date.now()
    ) {
      return res.status(401).send({
        message: 'Session expired',
      });
    }

    if (!ObjectId.isValid(session.userId)) {
      return res.status(401).send({
        message: 'Invalid user session',
      });
    }

    const user = await users.findOne({
      _id: new ObjectId(session.userId),
    });

    if (!user) {
      return res.status(401).send({
        message: 'User not found',
      });
    }

    if (user.banned === true) {
      return res.status(403).send({
        message: 'Your account has been suspended',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Token verification failed:', error);

    return res.status(401).send({
      message: 'Authentication failed',
    });
  }
};

// These middlewares must run after verifyToken

const verifySeeker = (req, res, next) => {
  if (req.user.role !== 'seeker') {
    return res.status(403).send({
      message: 'Seeker access only',
    });
  }

  next();
};

const verifyRecruiter = (req, res, next) => {
  if (req.user.role !== 'recruiter') {
    return res.status(403).send({
      message: 'Recruiter access only',
    });
  }

  next();
};

const verifyAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).send({
      message: 'Admin access only',
    });
  }

  next();
};

const isAdmin = (req) => req.user.role === 'admin';

const isJobOwner = (job, user) => {
  const ownerId = job.recruiterId || job.userId;

  return ownerId === user._id.toString();
};

const jobFields = [
  'title',
  'category',
  'type',
  'salaryMin',
  'salaryMax',
  'currency',
  'city',
  'country',
  'remote',
  'deadline',
  'responsibilities',
  'requirements',
  'benefits',
  'status',
  'company',
  'salaryFrequency',
];

const getJobData = (body) => {
  const data = {};

  for (const field of jobFields) {
    if (body[field] !== undefined) {
      data[field] = body[field];
    }
  }

  return data;
};

// ==============================
// USERS APIs
// ==============================

// Admin only
app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
  const result = await users.find(
    {},
    {
      projection: {
        name: 1,
        email: 1,
        image: 1,
        role: 1,
        banned: 1,
        banReason: 1,
        banExpires: 1,
        premium: 1,
        recruiterPremium: 1,
        createdAt: 1,
      },
    }
  ).toArray();

  res.send(result);
});

// User can access own premium status.
// Admin can access any user's premium status.
app.get(
  '/users/:id/premium',
  verifyToken,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: 'Invalid User ID',
      });
    }

    const isSelf = id === req.user._id.toString();

    if (!isSelf && !isAdmin(req)) {
      return res.status(403).send({
        message: 'Forbidden',
      });
    }

    const result = await users.findOne(
      { _id: new ObjectId(id) },
      {
        projection: {
          premium: 1,
          recruiterPremium: 1,
        },
      }
    );

    if (!result) {
      return res.status(404).send({
        message: 'User not found',
      });
    }

    res.send(result);
  }
);

// Update user role - Admin only
app.patch(
  '/users/:id/role',
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: 'Invalid User ID',
      });
    }

    if (!['admin', 'recruiter', 'seeker'].includes(role)) {
      return res.status(400).send({
        message: 'Invalid user role',
      });
    }

    if (id === req.user._id.toString() && role !== 'admin') {
      return res.status(400).send({
        message: 'You cannot remove your own admin role',
      });
    }

    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: 'User not found',
      });
    }

    res.send({
      message: 'User role updated successfully',
    });
  }
);

// Suspend user - Admin only
app.patch(
  '/users/:id/ban',
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: 'Invalid User ID',
      });
    }

    if (id === req.user._id.toString()) {
      return res.status(400).send({
        message: 'You cannot suspend your own account',
      });
    }

    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          banned: true,
          banReason: 'Suspended by admin',
          banExpires: null,
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: 'User not found',
      });
    }

    res.send({
      message: 'User suspended successfully',
    });
  }
);

// Activate user - Admin only
app.patch(
  '/users/:id/unban',
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: 'Invalid User ID',
      });
    }

    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { banned: false },
        $unset: {
          banReason: '',
          banExpires: '',
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: 'User not found',
      });
    }

    res.send({
      message: 'User activated successfully',
    });
  }
);

// Delete user - Admin only
app.delete(
  '/users/:id',
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: 'Invalid User ID',
      });
    }

    if (id === req.user._id.toString()) {
      return res.status(400).send({
        message: 'You cannot delete your own admin account',
      });
    }

    const result = await users.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        message: 'User not found',
      });
    }

    res.send({
      message: 'User deleted successfully',
    });
  }
);

// ==============================
// JOBS APIs
// ==============================

// Public job listing
app.get('/jobs', async (req, res) => {
  const query = {};

  if (req.query.jobType) {
    query.type = req.query.jobType;
  }

  if (req.query.remote) {
    query.remote = req.query.remote === 'true';
  }

  if (req.query.category) {
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

  const result = await jobs.find(query).toArray();

  res.send(result);
});

// Recruiter can see own job count.
// Admin can request a count for a specific user.
app.get(
  '/jobs/count',
  verifyToken,
  async (req, res) => {
    if (!['recruiter', 'admin'].includes(req.user.role)) {
      return res.status(403).send({
        message: 'Forbidden',
      });
    }

    let userId = req.user._id.toString();

    if (isAdmin(req) && req.query.userId) {
      userId = req.query.userId;
    }

    const count = await jobs.countDocuments({ userId });

    res.send({ count });
  }
);

// Public job details
app.get('/jobs/:id', async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({
      message: 'Invalid job ID',
    });
  }

  const result = await jobs.findOne({
    _id: new ObjectId(id),
  });

  if (!result) {
    return res.status(404).send({
      message: 'Job not found',
    });
  }

  res.send(result);
});

// Create job - Recruiter only
app.post(
  '/jobs',
  verifyToken,
  verifyRecruiter,
  async (req, res) => {
    const job = {
      ...getJobData(req.body),
      userId: req.user._id.toString(),
      recruiterId: req.user._id.toString(),
      applicants: 0,
      datePosted: new Date().toISOString(),
    };

    const result = await jobs.insertOne(job);

    res.status(201).send(result);
  }
);

// Update job - Owner recruiter or Admin
app.put(
  '/jobs/:id',
  verifyToken,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: 'Invalid job ID',
      });
    }

    if (!['recruiter', 'admin'].includes(req.user.role)) {
      return res.status(403).send({
        message: 'Forbidden',
      });
    }

    const job = await jobs.findOne({
      _id: new ObjectId(id),
    });

    if (!job) {
      return res.status(404).send({
        message: 'Job not found',
      });
    }

    if (!isAdmin(req) && !isJobOwner(job, req.user)) {
      return res.status(403).send({
        message: 'You do not own this job',
      });
    }

    const updatedJob = getJobData(req.body);

    const result = await jobs.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedJob }
    );

    res.send(result);
  }
);

// Delete job - Owner recruiter or Admin
app.delete(
  '/jobs/:id',
  verifyToken,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: 'Invalid job ID',
      });
    }

    if (!['recruiter', 'admin'].includes(req.user.role)) {
      return res.status(403).send({
        message: 'Forbidden',
      });
    }

    const job = await jobs.findOne({
      _id: new ObjectId(id),
    });

    if (!job) {
      return res.status(404).send({
        message: 'Job not found',
      });
    }

    if (!isAdmin(req) && !isJobOwner(job, req.user)) {
      return res.status(403).send({
        message: 'You do not own this job',
      });
    }

    const result = await jobs.deleteOne({
      _id: new ObjectId(id),
    });

    res.send(result);
  }
);

// ==============================
// APPLICATIONS APIs
// ==============================

// Seeker sees own applications.
// Recruiter sees applications for own jobs.
// Admin can see all applications.
app.get(
  '/applications',
  verifyToken,
  async (req, res) => {
    const query = {};

    if (req.user.role === 'seeker') {
      query.userId = req.user._id.toString();

      if (req.query.jobId) {
        query.jobId = req.query.jobId;
      }
    } else if (req.user.role === 'recruiter') {
      if (!req.query.jobId) {
        return res.status(400).send({
          message: 'Job ID is required',
        });
      }

      if (!ObjectId.isValid(req.query.jobId)) {
        return res.status(400).send({
          message: 'Invalid job ID',
        });
      }

      const job = await jobs.findOne({
        _id: new ObjectId(req.query.jobId),
      });

      if (!job) {
        return res.status(404).send({
          message: 'Job not found',
        });
      }

      if (!isJobOwner(job, req.user)) {
        return res.status(403).send({
          message: 'You do not own this job',
        });
      }

      query.jobId = req.query.jobId;
    } else if (req.user.role === 'admin') {
      if (req.query.jobId) {
        if (!ObjectId.isValid(req.query.jobId)) {
          return res.status(400).send({
            message: 'Invalid job ID',
          });
        }

        query.jobId = req.query.jobId;
      }

      if (req.query.applicantId) {
        query.userId = req.query.applicantId;
      }
    } else {
      return res.status(403).send({
        message: 'Forbidden',
      });
    }

    const result = await applications.find(query).toArray();

    res.send(result);
  }
);

// Seeker sees own application count.
// Admin can see total count or a specific user's count.
app.get(
  '/applications/count',
  verifyToken,
  async (req, res) => {
    const query = {};

    if (req.user.role === 'seeker') {
      query.userId = req.user._id.toString();
    } else if (req.user.role === 'admin') {
      if (req.query.applicantId) {
        query.userId = req.query.applicantId;
      }
    } else {
      return res.status(403).send({
        message: 'Forbidden',
      });
    }

    const count = await applications.countDocuments(query);

    res.send({ count });
  }
);

// Apply to a job - Seeker only
app.post(
  '/applications',
  verifyToken,
  verifySeeker,
  async (req, res) => {
    const { jobId } = req.body;

    if (!jobId || !ObjectId.isValid(jobId)) {
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

    if (isJobOwner(job, req.user)) {
      return res.status(403).send({
        message: 'You cannot apply to your own job',
      });
    }

    const application = {
      ...req.body,
      jobId,
      userId: req.user._id.toString(),
      email: req.user.email,
      jobTitle: job.title,
      companyName: job.company,
      isArchived: false,
    };

    const result = await applications.insertOne(application);

    res.status(201).send(result);
  }
);

// Update application status - Job owner recruiter or Admin
app.patch(
  '/applications/:id',
  verifyToken,
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: 'Invalid Application ID',
      });
    }

    if (!['recruiter', 'admin'].includes(req.user.role)) {
      return res.status(403).send({
        message: 'Forbidden',
      });
    }

    if (typeof status !== 'string' || !status.trim()) {
      return res.status(400).send({
        message: 'Valid status is required',
      });
    }

    const application = await applications.findOne({
      _id: new ObjectId(id),
    });

    if (!application) {
      return res.status(404).send({
        message: 'Application not found',
      });
    }

    if (!isAdmin(req)) {
      if (!ObjectId.isValid(application.jobId)) {
        return res.status(404).send({
          message: 'Related job not found',
        });
      }

      const job = await jobs.findOne({
        _id: new ObjectId(application.jobId),
      });

      if (!job) {
        return res.status(404).send({
          message: 'Related job not found',
        });
      }

      if (!isJobOwner(job, req.user)) {
        return res.status(403).send({
          message: 'You do not own this job',
        });
      }
    }

    const result = await applications.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status } }
    );

    res.send(result);
  }
);

// Archive application - Job owner recruiter or Admin
app.patch(
  '/applications/:id/archive',
  verifyToken,
  async (req, res) => {
    const { id } = req.params;
    const { isArchived } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: 'Invalid Application ID',
      });
    }

    if (!['recruiter', 'admin'].includes(req.user.role)) {
      return res.status(403).send({
        message: 'Forbidden',
      });
    }

    if (typeof isArchived !== 'boolean') {
      return res.status(400).send({
        message: 'isArchived must be a boolean',
      });
    }

    const application = await applications.findOne({
      _id: new ObjectId(id),
    });

    if (!application) {
      return res.status(404).send({
        message: 'Application not found',
      });
    }

    if (!isAdmin(req)) {
      if (!ObjectId.isValid(application.jobId)) {
        return res.status(404).send({
          message: 'Related job not found',
        });
      }

      const job = await jobs.findOne({
        _id: new ObjectId(application.jobId),
      });

      if (!job) {
        return res.status(404).send({
          message: 'Related job not found',
        });
      }

      if (!isJobOwner(job, req.user)) {
        return res.status(403).send({
          message: 'You do not own this job',
        });
      }
    }

    const result = await applications.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isArchived } }
    );

    res.send(result);
  }
);

// ==============================
// SAVED JOBS APIs
// ==============================

// Get own saved jobs - Seeker only
app.get(
  '/saved-jobs',
  verifyToken,
  verifySeeker,
  async (req, res) => {
    const userId = req.user._id.toString();

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

    res.send(result.filter(Boolean));
  }
);

// Save a job - Seeker only
app.post(
  '/saved-jobs',
  verifyToken,
  verifySeeker,
  async (req, res) => {
    const { jobId } = req.body;

    if (!jobId || !ObjectId.isValid(jobId)) {
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
      userId: req.user._id.toString(),
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

      console.error('Save job failed:', error);

      res.status(500).send({
        message: 'Failed to save job',
      });
    }
  }
);

// Remove saved job - Owner seeker only
app.delete(
  '/saved-jobs/:id',
  verifyToken,
  verifySeeker,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: 'Invalid Saved Job ID',
      });
    }

    const result = await savedJobs.deleteOne({
      _id: new ObjectId(id),
      userId: req.user._id.toString(),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        message: 'Saved job not found',
      });
    }

    res.send({
      message: 'Saved job removed successfully',
    });
  }
);

// ==============================
// PAYMENTS APIs
// ==============================

// Verify Stripe checkout - Authenticated user only
app.post(
  '/payments/checkout-verify',
  verifyToken,
  async (req, res) => {
    try {
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).send({
          success: false,
          message: 'Session ID is required',
        });
      }

      const checkoutSession =
        await stripe.checkout.sessions.retrieve(sessionId);

      const {
        status,
        payment_status,
        customer_email,
        metadata,
        payment_intent,
      } = checkoutSession;

      if (status !== 'complete' || payment_status !== 'paid') {
        return res.status(400).send({
          success: false,
          message: 'Payment verification failed',
        });
      }

      if (!metadata || metadata.userId !== req.user._id.toString()) {
        return res.status(403).send({
          success: false,
          message: 'This payment does not belong to you',
        });
      }

      const plan = metadata.plan || 'seeker';

      if (!['seeker', 'recruiter'].includes(plan)) {
        return res.status(400).send({
          success: false,
          message: 'Invalid payment plan',
        });
      }

      if (plan !== req.user.role) {
        return res.status(403).send({
          success: false,
          message: 'Payment plan does not match your account role',
        });
      }

      const existingPayment = await payments.findOne({
        sessionId,
      });

      if (existingPayment) {
        if (existingPayment.userId !== req.user._id.toString()) {
          return res.status(403).send({
            success: false,
            message: 'Payment does not belong to you',
          });
        }

        return res.send({
          success: true,
          message: 'Payment already verified',
        });
      }

      const payment = {
        sessionId,
        status,
        payment_status,
        customer_email,
        userId: req.user._id.toString(),
        plan,
        payment_date: new Date(),
        payment_intent,
      };

      const result = await payments.insertOne(payment);

      const premiumField =
        plan === 'recruiter'
          ? 'recruiterPremium'
          : 'premium';

      const updateResult = await users.updateOne(
        { _id: req.user._id },
        {
          $set: {
            [premiumField]: true,
          },
        }
      );

      res.send({
        success: true,
        result,
        updateResult,
      });
    } catch (error) {
      console.error('Payment verification failed:', error);

      res.status(500).send({
        success: false,
        message: 'Payment verification failed',
      });
    }
  }
);

app.listen(port, () => {
  console.log(`hire loop is running on port ${port}`);
});
