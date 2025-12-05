## Classes

<dl>
<dt><a href="#StarCitizen">StarCitizen</a> ⇐ <code>Hub</code></dt>
<dd><p>Core service for Star Citizen.
Provides a Fabric-compatible declarative API with Discord integration.</p>
</dd>
</dl>

## Typedefs

<dl>
<dt><a href="#StarCitizenActivity">StarCitizenActivity</a> : <code>Object</code></dt>
<dd></dd>
<dt><a href="#StarCitizenPlayer">StarCitizenPlayer</a> : <code>Object</code></dt>
<dd></dd>
<dt><a href="#StarCitizenVehicle">StarCitizenVehicle</a> : <code>Object</code></dt>
<dd></dd>
<dt><a href="#StarCitizenKill">StarCitizenKill</a> : <code>Object</code></dt>
<dd></dd>
<dt><a href="#StarCitizenLogEntry">StarCitizenLogEntry</a> : <code>Object</code></dt>
<dd></dd>
<dt><a href="#DiscordConfig">DiscordConfig</a> : <code>Object</code></dt>
<dd></dd>
<dt><a href="#StarCitizenSettings">StarCitizenSettings</a> : <code>Object</code></dt>
<dd></dd>
</dl>

## Interfaces

<dl>
<dt><a href="#StarCitizenAPI">StarCitizenAPI</a></dt>
<dd><p>Declarative API interface for Star Citizen Live service.</p>
<p>This interface defines the properties and methods exposed by the
StarCitizen service for programmatic access to game data.</p>
</dd>
</dl>

<a name="StarCitizenAPI"></a>

## StarCitizenAPI
Declarative API interface for Star Citizen Live service.

This interface defines the properties and methods exposed by the
StarCitizen service for programmatic access to game data.

**Kind**: global interface  

* [StarCitizenAPI](#StarCitizenAPI)
    * [.activities](#StarCitizenAPI+activities) ⇒ [<code>Array.&lt;StarCitizenActivity&gt;</code>](#StarCitizenActivity)
    * [.players](#StarCitizenAPI+players) ⇒ [<code>Array.&lt;StarCitizenPlayer&gt;</code>](#StarCitizenPlayer)
    * [.vehicles](#StarCitizenAPI+vehicles) ⇒ [<code>Array.&lt;StarCitizenVehicle&gt;</code>](#StarCitizenVehicle)
    * [.kills](#StarCitizenAPI+kills) ⇒ [<code>Array.&lt;StarCitizenKill&gt;</code>](#StarCitizenKill)
    * [.logs](#StarCitizenAPI+logs) ⇒ [<code>Array.&lt;StarCitizenLogEntry&gt;</code>](#StarCitizenLogEntry)
    * [.status](#StarCitizenAPI+status) ⇒ <code>String</code>
    * [.postToDiscord(payload)](#StarCitizenAPI+postToDiscord) ⇒ <code>Promise.&lt;Response&gt;</code>
    * [.announceActivity(activity)](#StarCitizenAPI+announceActivity) ⇒ <code>Promise.&lt;Response&gt;</code>
    * [.screenshot()](#StarCitizenAPI+screenshot) ⇒ <code>Promise.&lt;Buffer&gt;</code>
    * [.start()](#StarCitizenAPI+start) ⇒ [<code>Promise.&lt;StarCitizenAPI&gt;</code>](#StarCitizenAPI)
    * [.stop()](#StarCitizenAPI+stop) ⇒ [<code>Promise.&lt;StarCitizenAPI&gt;</code>](#StarCitizenAPI)

<a name="StarCitizenAPI+activities"></a>

### starCitizenAPI.activities ⇒ [<code>Array.&lt;StarCitizenActivity&gt;</code>](#StarCitizenActivity)
Get all activities.

**Kind**: instance property of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: [<code>Array.&lt;StarCitizenActivity&gt;</code>](#StarCitizenActivity) - Array of activities  
<a name="StarCitizenAPI+players"></a>

### starCitizenAPI.players ⇒ [<code>Array.&lt;StarCitizenPlayer&gt;</code>](#StarCitizenPlayer)
Get all players.

**Kind**: instance property of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: [<code>Array.&lt;StarCitizenPlayer&gt;</code>](#StarCitizenPlayer) - Array of players  
<a name="StarCitizenAPI+vehicles"></a>

### starCitizenAPI.vehicles ⇒ [<code>Array.&lt;StarCitizenVehicle&gt;</code>](#StarCitizenVehicle)
Get all vehicles.

**Kind**: instance property of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: [<code>Array.&lt;StarCitizenVehicle&gt;</code>](#StarCitizenVehicle) - Array of vehicles  
<a name="StarCitizenAPI+kills"></a>

### starCitizenAPI.kills ⇒ [<code>Array.&lt;StarCitizenKill&gt;</code>](#StarCitizenKill)
Get all kills.

**Kind**: instance property of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: [<code>Array.&lt;StarCitizenKill&gt;</code>](#StarCitizenKill) - Array of kill events  
<a name="StarCitizenAPI+logs"></a>

### starCitizenAPI.logs ⇒ [<code>Array.&lt;StarCitizenLogEntry&gt;</code>](#StarCitizenLogEntry)
Get all log entries.

**Kind**: instance property of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: [<code>Array.&lt;StarCitizenLogEntry&gt;</code>](#StarCitizenLogEntry) - Array of log entries  
<a name="StarCitizenAPI+status"></a>

### starCitizenAPI.status ⇒ <code>String</code>
Get service status.

**Kind**: instance property of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: <code>String</code> - Current status ('STOPPED', 'STARTING', 'STARTED', 'STOPPING')  
<a name="StarCitizenAPI+postToDiscord"></a>

### starCitizenAPI.postToDiscord(payload) ⇒ <code>Promise.&lt;Response&gt;</code>
Post a message to Discord via webhook.

**Kind**: instance method of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: <code>Promise.&lt;Response&gt;</code> - Fetch response  

| Param | Type | Description |
| --- | --- | --- |
| payload | <code>Object</code> | Discord webhook payload |
| [payload.embeds] | <code>Array.&lt;Object&gt;</code> | Array of Discord embeds |

<a name="StarCitizenAPI+announceActivity"></a>

### starCitizenAPI.announceActivity(activity) ⇒ <code>Promise.&lt;Response&gt;</code>
Announce an activity to the configured authority.

**Kind**: instance method of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: <code>Promise.&lt;Response&gt;</code> - Fetch response  

| Param | Type | Description |
| --- | --- | --- |
| activity | [<code>StarCitizenActivity</code>](#StarCitizenActivity) | Activity to announce |

<a name="StarCitizenAPI+screenshot"></a>

### starCitizenAPI.screenshot() ⇒ <code>Promise.&lt;Buffer&gt;</code>
Take a screenshot of the current display.

**Kind**: instance method of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: <code>Promise.&lt;Buffer&gt;</code> - Screenshot image buffer  
<a name="StarCitizenAPI+start"></a>

### starCitizenAPI.start() ⇒ [<code>Promise.&lt;StarCitizenAPI&gt;</code>](#StarCitizenAPI)
Start the service.
Begins monitoring the game log and starts HTTP server if configured.

**Kind**: instance method of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: [<code>Promise.&lt;StarCitizenAPI&gt;</code>](#StarCitizenAPI) - Returns this for chaining  
**Emits**: <code>event:ready When service is fully started</code>, <code>event:error If an error occurs during startup</code>  
<a name="StarCitizenAPI+stop"></a>

### starCitizenAPI.stop() ⇒ [<code>Promise.&lt;StarCitizenAPI&gt;</code>](#StarCitizenAPI)
Stop the service.
Stops monitoring the game log and stops HTTP server if running.

**Kind**: instance method of [<code>StarCitizenAPI</code>](#StarCitizenAPI)  
**Returns**: [<code>Promise.&lt;StarCitizenAPI&gt;</code>](#StarCitizenAPI) - Returns this for chaining  
**Emits**: <code>event:stopped When service is fully stopped</code>  
<a name="StarCitizen"></a>

## StarCitizen ⇐ <code>Hub</code>
Core service for Star Citizen.
Provides a Fabric-compatible declarative API with Discord integration.

**Kind**: global class  
**Extends**: <code>Hub</code>  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| activities | <code>Array</code> | Collection of activities from the game log. |
| players | <code>Array</code> | Collection of known players. |
| vehicles | <code>Array</code> | Collection of known vehicles. |
| logs | <code>Array</code> | Collection of log entries. |
| kills | <code>Array</code> | Collection of kill events. |
| discord | <code>Object</code> | Discord integration instance. |


* [StarCitizen](#StarCitizen) ⇐ <code>Hub</code>
    * [new StarCitizen([settings])](#new_StarCitizen_new)
    * [.postToDiscord(payload)](#StarCitizen+postToDiscord) ⇒ <code>Promise.&lt;Response&gt;</code>

<a name="new_StarCitizen_new"></a>

### new StarCitizen([settings])
Create an instance of the Star Citizen service.

**Returns**: [<code>StarCitizen</code>](#StarCitizen) - A new instance of the Star Citizen service.  

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| [settings] | <code>Object</code> |  | Configuration for this instance. |
| [settings.logfile] | <code>Object</code> | <code>C:/Program Files/Roberts Space Industries/StarCitizen/LIVE/Game.log</code> | Path to the log file for Star Citizen. |
| [settings.discord] | <code>Object</code> |  | Discord configuration. |
| [settings.discord.webhook] | <code>String</code> |  | Discord webhook URL for posting updates. |
| [settings.discord.channel] | <code>String</code> |  | Discord channel ID for posting updates. |
| [settings.discord.enable] | <code>Boolean</code> | <code>false</code> | Enable Discord integration. |

<a name="StarCitizen+postToDiscord"></a>

### starCitizen.postToDiscord(payload) ⇒ <code>Promise.&lt;Response&gt;</code>
Post a message to Discord via webhook.

**Kind**: instance method of [<code>StarCitizen</code>](#StarCitizen)  
**Returns**: <code>Promise.&lt;Response&gt;</code> - The fetch response.  

| Param | Type | Description |
| --- | --- | --- |
| payload | <code>Object</code> | The Discord webhook payload. |

<a name="StarCitizenActivity"></a>

## StarCitizenActivity : <code>Object</code>
**Kind**: global typedef  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| id | <code>String</code> | Unique identifier for the activity |
| type | <code>String</code> | Type of activity (e.g., 'StarCitizenLogEntry', 'MissionComplete') |
| actor | <code>Object</code> | The actor performing the activity |
| actor.id | <code>String</code> | Actor ID |
| [actor.name] | <code>String</code> | Actor name |
| object | <code>Object</code> | The object of the activity |
| object.id | <code>String</code> | Object ID |
| [object.content] | <code>String</code> | Object content |
| target | <code>String</code> | Target path of the activity |
| timestamp | <code>String</code> | ISO timestamp of the activity |

<a name="StarCitizenPlayer"></a>

## StarCitizenPlayer : <code>Object</code>
**Kind**: global typedef  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| id | <code>String</code> | Unique identifier for the player |
| name | <code>String</code> | Player name |
| timestamp | <code>String</code> | ISO timestamp when player was registered |
| [metadata] | <code>Object</code> | Additional player metadata |

<a name="StarCitizenVehicle"></a>

## StarCitizenVehicle : <code>Object</code>
**Kind**: global typedef  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| id | <code>String</code> | Unique identifier for the vehicle |
| name | <code>String</code> | Vehicle name |
| [type] | <code>String</code> | Vehicle type (e.g., 'fighter', 'transport') |
| [owner] | <code>String</code> | Owner player ID |
| timestamp | <code>String</code> | ISO timestamp when vehicle was registered |

<a name="StarCitizenKill"></a>

## StarCitizenKill : <code>Object</code>
**Kind**: global typedef  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| id | <code>String</code> | Unique identifier for the kill event |
| killer | <code>String</code> | Name or ID of the killer |
| victim | <code>String</code> | Name or ID of the victim |
| [weapon] | <code>String</code> | Weapon used for the kill |
| timestamp | <code>String</code> | ISO timestamp of the kill event |

<a name="StarCitizenLogEntry"></a>

## StarCitizenLogEntry : <code>Object</code>
**Kind**: global typedef  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| id | <code>String</code> | Unique identifier for the log entry |
| timestamp | <code>String</code> | Timestamp from the log file |
| parts | <code>Array.&lt;String&gt;</code> | Parsed parts of the log entry |
| [content] | <code>String</code> | Raw log content |

<a name="DiscordConfig"></a>

## DiscordConfig : <code>Object</code>
**Kind**: global typedef  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| enable | <code>Boolean</code> | Whether Discord integration is enabled |
| [webhook] | <code>String</code> | Discord webhook URL |
| [channel] | <code>String</code> | Discord channel ID |
| announceActivities | <code>Boolean</code> | Whether to announce activities to Discord |
| announceKills | <code>Boolean</code> | Whether to announce kills to Discord |
| announcePlayerJoins | <code>Boolean</code> | Whether to announce player joins to Discord |

<a name="StarCitizenSettings"></a>

## StarCitizenSettings : <code>Object</code>
**Kind**: global typedef  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| [name] | <code>String</code> | Service name |
| [authority] | <code>String</code> | Authority URL for announcements |
| [logfile] | <code>String</code> | Path to Star Citizen game log file |
| [http] | <code>Object</code> | HTTP server configuration |
| [http.enable] | <code>Boolean</code> | Whether to enable HTTP server |
| [http.port] | <code>Number</code> | HTTP server port |
| [discord] | [<code>DiscordConfig</code>](#DiscordConfig) | Discord integration configuration |

