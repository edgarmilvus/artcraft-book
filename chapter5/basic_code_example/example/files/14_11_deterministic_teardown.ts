    } finally {
      // Deterministic teardown: the child exits even if we crashed.
      await pc?.close();
    }
