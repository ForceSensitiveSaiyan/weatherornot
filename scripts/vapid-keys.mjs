// Makes the key pair for morning notifications. Run once, then add both
// values as GitHub secrets (WEATHERORNOT_VAPID_PUBLIC_KEY and
// WEATHERORNOT_VAPID_PRIVATE_KEY). Changing them later turns everyone's
// notifications off until they turn them on again.
import { vapidKeys } from '../src/push.js';

const { publicKey, privateKey } = vapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}`);
