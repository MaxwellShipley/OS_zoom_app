import express from 'express';
import { getInstallURL } from '../helpers/zoom-api.js';

const router = express.Router();

router.get('/', (req, res, next) => {
    const { url, state, verifier } = getInstallURL();
    req.session.state = state;
    req.session.verifier = verifier;

    // DEBUGGING: Log the values being set in the session
    console.log('--- PRE-AUTHORIZATION (at /) ---');
    console.log('Session ID:', req.session.id);
    console.log('Setting session state:', req.session.state);
    console.log('Setting session verifier:', req.session.verifier);
    console.log('----------------------------------');

    // Explicitly save the session before rendering the page
    req.session.save((err) => {
        if (err) {
            console.error('Error saving session:', err);
            return next(err);
        }
        console.log('✅ Session saved successfully before redirect.');
        res.render('index', { url });
    });
});

export default router;