# Changelog
All notable changes to this project will be documented in this file.

## [0.1.0-RC1] - 2025-12-05
### Added

## [0.1.0-dev] - 2024-12-05
### Added
#### Declarative API
- Declarative properties on service instances: `activities`, `players`, `vehicles`, `kills`, `logs`, `status`
- Type definitions for all API entities in `types/StarCitizenAPI.js`
- Comprehensive test suite for declarative API in `tests/declarative-api.js`

#### Discord Integration
- Discord webhook integration for game event announcements
- Configurable announcement types (activities, kills, player joins)
- Rich embed support with color coding and timestamps
- `postToDiscord()` method for custom Discord messages
- Automatic Discord wiring when enabled in settings
- Event handlers for Discord announcements: `_handleActivityForDiscord`, `_handleKillForDiscord`, `_handlePlayerJoinForDiscord`

#### HTTP Endpoints
- RESTful endpoints for all resource collections
- `GET /services/star-citizen` - Service status and statistics
- `GET /services/star-citizen/activities` - List activities
- `POST /services/star-citizen/activities` - Create activity
- `GET /services/star-citizen/players` - List players
- `POST /services/star-citizen/players` - Register player
- `GET /services/star-citizen/vehicles` - List vehicles
- `POST /services/star-citizen/vehicles` - Register vehicle
- `GET /services/star-citizen/kills` - List kills
- `POST /services/star-citizen/kills` - Register kill
- `GET /services/star-citizen/messages` - List messages
- `POST /services/star-citizen/messages` - Create message

#### State Management
- Extended state to include `activities`, `kills` collections
- Proper state initialization with all collection types
- State commit on all collection updates

#### Events
- New event types: `kill`, `player:join`, `ready`, `stopped`
- Enhanced `activity` event with proper structure
- Event-driven Discord integration

#### Documentation
- Comprehensive README with features and usage examples
- API.md with complete API documentation
- INTEGRATION.md guide for Discord, Fabric, and Sensemaker integration
- Example code in `examples/discord-integration.js`
- Example code in `examples/declarative-api.js`
- Settings example file in `settings/example.js`
- Environment variable example in `.env.example` (would be created)

#### Configuration
- Discord configuration in settings
- Environment variable support for Discord webhook
- Configurable announcement flags
- HTTP enable/disable flag

#### Developer Experience
- Test suite for declarative API
- JSDoc comments throughout codebase
- Type definitions for better IDE support
- .gitignore for clean repository

### Changed
- Updated package.json with new dependencies (cross-fetch, lodash.merge)
- Updated package.json keywords to include Discord and gaming
- Enhanced service description to mention Discord integration
- Improved log change handler to store activities
- Enhanced HTTP request handlers to return structured responses
- Updated start/stop methods with better logging and error handling

### Fixed
- Activities now properly stored when log changes occur
- Proper status management throughout lifecycle
- HTTP handler for kills now uses correct method signature
- State properties now safely handle undefined collections

## [0.0.1] - Previous
### Added
- Initial Star Citizen log monitoring
- Basic HTTP server
- Fabric Hub integration
- Log parsing
- Screenshot capability
- Activity announcements to authority

[0.1.0-dev]: https://github.com/GoonCitizen/star-citizen-live/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/GoonCitizen/star-citizen-live/releases/tag/v0.0.1

