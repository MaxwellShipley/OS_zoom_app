import express from 'express';
import { getToken, getDeeplink, getZoomUser } from '../helpers/zoom-api.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
    // DEBUGGING: Log everything we receive on the callback
    console.log('\n--- POST-AUTHORIZATION CALLBACK (at /auth) ---');
    console.log('Request Query:', req.query);
    console.log('Session ID on callback:', req.session.id);
    console.log('Full session object on callback:', req.session);
    console.log('--------------------------------------------');

    const verifier = req.session?.verifier;
    console.log('Retrieved verifier from session:', verifier);


    if (req.query.code && req.query.state === req.session.state) {
        try {
            const { code } = req.query;
            // The verifier is already retrieved above

            // Get Access Token
            const { access_token } = await getToken(code, verifier);
            const zoomUser = await getZoomUser('me', access_token);

            // Store token and user info in session
            req.session.accessToken = access_token;
            req.session.userId = zoomUser.id;

            console.log('✅ User authorized successfully. Token stored in session.');

            // Get deeplink and redirect back to Zoom
            const deeplink = await getDeeplink(access_token);
            res.redirect(deeplink);
        } catch (e) {
            console.error('Error in /auth route handler:', e);
            next(e);
        }
    } else {
        const err = new Error('Invalid state or code. State mismatch or code missing.');
        console.error(err.message);
        console.error('Expected state:', req.session?.state, ' | Received state:', req.query.state);
        next(err);
    }
});

export default router;