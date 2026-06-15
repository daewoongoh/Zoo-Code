import * as vscode from "vscode"
import { Package } from "../../../shared/package"

export function getApiRequestTimeout(): number {
	const configTimeout = vscode.workspace.getConfiguration(Package.name).get<number>("apiRequestTimeout", 600)

	// Validate that it's actually a number and not NaN
	if (typeof configTimeout !== "number" || isNaN(configTimeout)) {
		return 600 * 1000 // Default to 600 seconds
	}

	return Math.round(configTimeout * 1000) // Convert to milliseconds
}
