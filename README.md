# `@fabric/star-citizen-live`
Fabric connectivity for the Star Citizen universe with Discord integration.

## Features
- 🎮 Real-time log monitoring from Star Citizen game client
- 🔗 Fabric-compatible declarative API
- 💬 Discord webhook integration for activity announcements
- 📊 RESTful HTTP endpoints for activities, players, vehicles, and kills
- 🎯 Event-driven architecture with Fabric event system

## Installation

```bash
npm install
```

## Configuration

Create a `settings/local.js` file based on `settings/example.js`:

```javascript
module.exports = {
  logfile: 'C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/Game.log',
  http: {
    enable: true,
    port: 3041
  },
  discord: {
    enable: true,
    webhook: 'YOUR_DISCORD_WEBHOOK_URL',
    announceActivities: true,
    announceKills: true,
    announcePlayerJoins: true
  }
};
```

### Discord Setup

1. Go to your Discord server settings
2. Navigate to Integrations → Webhooks
3. Create a new webhook
4. Copy the webhook URL
5. Add it to your `settings/local.js` configuration

Alternatively, use environment variables:

```bash
export DISCORD_WEBHOOK_URL='your_webhook_url_here'
export DISCORD_CHANNEL_ID='your_channel_id_here'
```

## Usage
### Standalone Service
```bash
npm start
```

### As a Fabric Service
```javascript
const StarCitizen = require('@rsi/star-citizen');
const sc = new StarCitizen({
  logfile: 'path/to/Game.log',
  discord: {
    enable: true,
    webhook: 'YOUR_WEBHOOK_URL'
  }
});

// Access declarative properties
console.log(sc.activities);  // Array of activities
console.log(sc.players);     // Array of players
console.log(sc.vehicles);    // Array of vehicles
console.log(sc.kills);       // Array of kills
console.log(sc.logs);        // Array of log entries

// Listen to events
sc.on('activity', (activity) => {
  console.log('New activity:', activity);
});

sc.on('kill', (kill) => {
  console.log('Kill event:', kill);
});

sc.on('player:join', (player) => {
  console.log('Player joined:', player);
});

await sc.start();
```

## Declarative API
The service exposes the following declarative properties on instances:

### Properties
- `activities` - Collection of all activities
- `players` - Collection of known players
- `vehicles` - Collection of known vehicles
- `kills` - Collection of kill events
- `logs` - Collection of log entries
- `status` - Current service status

### HTTP Endpoints
When HTTP is enabled, the following endpoints are available:

- `GET /services/star-citizen` - Service status and statistics
- `GET /services/star-citizen/activities` - List all activities
- `POST /services/star-citizen/activities` - Create an activity
- `GET /services/star-citizen/players` - List all players
- `POST /services/star-citizen/players` - Register a player
- `GET /services/star-citizen/vehicles` - List all vehicles
- `POST /services/star-citizen/vehicles` - Register a vehicle
- `GET /services/star-citizen/kills` - List all kills
- `POST /services/star-citizen/kills` - Register a kill
- `GET /services/star-citizen/messages` - List all messages
- `POST /services/star-citizen/messages` - Create a message

## Discord Integration
When Discord integration is enabled, the service will automatically post to Discord:

- 🎮 **Activities** - Game log events and activities
- 💀 **Kill Events** - Player eliminations with killer, victim, and weapon
- 👤 **Player Joins** - When players enter the verse

Each Discord message includes:
- Rich embeds with color coding
- Relevant fields (actor, object, target, etc.)
- Timestamps
- Appropriate emojis

## Events
The service emits the following Fabric events:

- `activity` - Emitted when a new activity is detected
- `kill` - Emitted when a kill event occurs
- `player:join` - Emitted when a player joins
- `log` - Emitted for log entries
- `ready` - Emitted when service is fully started
- `stopped` - Emitted when service is stopped
- `error` - Emitted on errors

## Development
```bash
# Run tests
npm test

# Generate API documentation
npm run make:api

# Generate TODO report
npm run report:todo
```

## Integration with Sensemaker
This service can be integrated into a Sensemaker instance:

```javascript
const Sensemaker = require('@fabric/sensemaker');
const StarCitizen = require('@rsi/star-citizen');

const sensemaker = new Sensemaker({
  rsi: {
    enable: true,
    logfile: 'path/to/Game.log',
    discord: {
      enable: true,
      webhook: 'YOUR_WEBHOOK_URL'
    }
  }
});

await sensemaker.start();

// Access via sensemaker.rsi
console.log(sensemaker.rsi.activities);
```

## License
MIT

## Credits
Built with [Fabric](https://fabric.pub) by Fabric Labs.
